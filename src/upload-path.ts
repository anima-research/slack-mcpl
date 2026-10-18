import { constants, openSync, closeSync, fstatSync, realpathSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { MAX_ATTACHMENT_BYTES } from './content.js';
export type PathUploadPolicy = { mode: 'restricted'; directories: string[] } | { mode: 'unrestricted' };

/** Configuration is explicit, copied and frozen; an empty restriction must not
 * accidentally enable access to the whole filesystem. */
export function validatePathUploadPolicy(value: unknown): PathUploadPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid path upload policy');
  const config = value as Record<string, unknown>;
  const keys = Reflect.ownKeys(config);
  if (config.mode === 'unrestricted' && keys.length === 1 && keys[0] === 'mode') return Object.freeze({ mode: 'unrestricted' });
  if (config.mode !== 'restricted' || keys.length !== 2 || !keys.includes('mode') || !keys.includes('directories')
      || !Array.isArray(config.directories) || config.directories.length === 0
      || !config.directories.every((path) => typeof path === 'string' && isAbsolute(path) && !path.includes('\0'))) {
    throw new Error('Path uploads require unrestricted mode or restricted mode with nonempty absolute directories');
  }
  const directories = [...config.directories] as string[];
  Object.freeze(directories);
  return Object.freeze({ mode: 'restricted', directories });
}

const REQUEST_LIMIT = 64 * 1024;
const STDERR_LIMIT = 1024;
const WORKER_TIMEOUT_MS = 5000;
const PYTHON_PATH = '/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin';
const WORKER_ERRORS: Record<string, string> = {
  INVALID: 'Invalid restricted upload path',
  ROOT_CHANGED: 'Configured upload root was replaced or moved',
  OUTSIDE: 'Opened upload file is outside the pinned root or no longer linked',
  NOT_REGULAR: 'Upload path must name a regular file',
  TOO_LARGE: 'File exceeds the 5 MiB upload limit',
  UNREADABLE: 'Upload path is unreadable, unverifiable or contains a symlink',
};

const PYTHON_COMMON = String.raw`
import os, sys, stat, json
if sys.version_info < (3, 9) or sys.platform not in ('linux', 'darwin'):
    raise RuntimeError('unsupported platform')
if os.open not in os.supports_dir_fd or not all(hasattr(os, key) for key in ('O_DIRECTORY', 'O_NOFOLLOW', 'O_NONBLOCK')):
    raise RuntimeError('missing directory descriptor support')
if sys.platform == 'darwin':
    import fcntl
    if not hasattr(fcntl, 'F_GETPATH'): raise RuntimeError('missing descriptor path support')
DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
class Refused(Exception): pass
def refuse(code): raise Refused(code)
def same(a, b): return a.st_dev == b.st_dev and a.st_ino == b.st_ino
def valid(part): return isinstance(part, str) and part not in ('', '.', '..') and '/' not in part and '\0' not in part
def fd_path(fd):
    if os.fstat(fd).st_nlink == 0: refuse('OUTSIDE')
    if sys.platform == 'linux':
        path = os.readlink('/proc/self/fd/' + str(fd))
        # Linux's deleted suffix can survive when another hardlink exists.
        # Its ambiguity is rejected conservatively, including literal names.
        if path.endswith(' (deleted)'): refuse('OUTSIDE')
    else:
        raw = fcntl.fcntl(fd, fcntl.F_GETPATH, b'\0' * 1024)
        if b'\0' not in raw: refuse('UNREADABLE')
        path = os.fsdecode(raw.split(b'\0', 1)[0])
    if not os.path.isabs(path) or '\0' in path: refuse('UNREADABLE')
    # This is the kernel's descriptor path. Do not realpath it: that would
    # resolve a separately mutable pathname instead of describing this FD.
    return path
`;

/** Optional restricted backend: Python 3.9+ stdlib, isolated from user imports.
 * Exported only so tests can derive programs with deterministic race schedules;
 * production has no hook, test environment switch or user-controlled code.
 * Root/leaf descriptor paths are admission observations before and after reads,
 * not a sandbox against same-user code, hardlinks, mounts or later mutations. */
export const RESTRICTED_UPLOAD_WORKER_SOURCE = PYTHON_COMMON + String.raw`
LIMIT = ${MAX_ATTACHMENT_BYTES}
REQUEST_LIMIT = ${REQUEST_LIMIT}
fds = {3}
def opened(path, flags, parent=None):
    fd = os.open(path, flags, dir_fd=parent)
    fds.add(fd)
    return fd
def beneath(file, canonical):
    if fd_path(3) != canonical: refuse('ROOT_CHANGED')
    actual = fd_path(file)
    if actual == canonical or os.path.commonpath((canonical, actual)) != canonical: refuse('OUTSIDE')
try:
    raw = sys.stdin.buffer.read(REQUEST_LIMIT + 1)
    if len(raw) > REQUEST_LIMIT: refuse('INVALID')
    request = json.loads(raw)
    canonical, parts = request['root'], request['parts']
    if not isinstance(canonical, str) or not canonical.startswith('/') or '\0' in canonical:
        refuse('INVALID')
    root_parts = [part for part in canonical.split('/') if part]
    if not all(valid(part) for part in root_parts) or not isinstance(parts, list) or not parts or not all(valid(part) for part in parts):
        refuse('INVALID')
    current = opened('/', DIR_FLAGS)
    for part in root_parts:
        current = opened(part, DIR_FLAGS, current)
    if not same(os.fstat(current), os.fstat(3)): refuse('ROOT_CHANGED')
    for part in parts[:-1]:
        current = opened(part, DIR_FLAGS, current)
    file = opened(parts[-1], os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW, current)
    info = os.fstat(file)
    if not stat.S_ISREG(info.st_mode): refuse('NOT_REGULAR')
    if info.st_size > LIMIT: refuse('TOO_LARGE')
    beneath(file, canonical)
    # First byte read happens only after the actual opened FD is admitted.
    chunks, size = [], 0
    while size <= LIMIT:
        chunk = os.read(file, min(65536, LIMIT + 1 - size))
        if not chunk: break
        chunks.append(chunk)
        size += len(chunk)
    if size > LIMIT: refuse('TOO_LARGE')
    beneath(file, canonical)
    # Never emit partial data before both descriptor-path checks succeed.
    sys.stdout.buffer.write(b''.join(chunks))
    sys.stdout.buffer.flush()
except Exception as error:
    code = str(error) if isinstance(error, Refused) else 'UNREADABLE'
    if code not in ('INVALID', 'ROOT_CHANGED', 'OUTSIDE', 'NOT_REGULAR', 'TOO_LARGE'): code = 'UNREADABLE'
    sys.stderr.write(code)
    sys.exit(1)
finally:
    for fd in fds:
        try: os.close(fd)
        except OSError: pass
`;

interface Root { alias: string; canonical: string; fd: number }

export class PathUploadReader {
  readonly policy: PathUploadPolicy;
  private roots: Root[] = [];
  private python?: string;
  private children = new Map<ChildProcess, () => void>();
  private closed = false;

  constructor(policy: PathUploadPolicy) {
    this.policy = validatePathUploadPolicy(policy);
    if (!['linux', 'darwin'].includes(process.platform)
        || ![constants.O_DIRECTORY, constants.O_NOFOLLOW, constants.O_NONBLOCK].every((flag) => typeof flag === 'number' && flag !== 0)) {
      throw new Error('Path uploads require supported POSIX directory and no-follow flags');
    }
    try {
      if (this.policy.mode === 'restricted') {
        // PATH contains fixed operator install locations, never cwd or user
        // environment values. -I -S prevents Python startup/import injection.
        const probe = spawnSync('python3', ['-I', '-S', '-c', PYTHON_COMMON + "\nfd = os.open('/', DIR_FLAGS)\ntry:\n    assert fd_path(fd) == '/'\n    print(json.dumps(sys.executable))\nfinally:\n    os.close(fd)\n"], {
          cwd: '/', shell: false, env: { PATH: PYTHON_PATH }, encoding: 'utf8', maxBuffer: 4096, timeout: WORKER_TIMEOUT_MS,
        });
        if (probe.error || probe.status !== 0 || probe.stderr) throw new Error('Restricted uploads require Python 3.9+ and descriptor-path support');
        const executable: unknown = JSON.parse(probe.stdout);
        if (typeof executable !== 'string' || !isAbsolute(executable) || executable.includes('\0')) throw new Error('Invalid Python executable');
        this.python = executable;
        for (const directory of this.policy.directories) {
          const alias = resolve(directory);
          const canonical = realpathSync(alias);
          const fd = openSync(canonical, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
          this.roots.push({ alias, canonical, fd });
          if (!fstatSync(fd).isDirectory()) throw new Error('Upload root must be a directory');
        }
      }
    } catch {
      this.close();
      throw new Error('Restricted uploads require Python 3.9+, descriptor-path support and readable directory roots');
    }
  }

  async read(absolutePath: string): Promise<Buffer> {
    if (this.closed) throw new Error('Path upload reader is closed');
    if (typeof absolutePath !== 'string' || !isAbsolute(absolutePath) || absolutePath.includes('\0')
        || absolutePath.split(sep).includes('..')) throw new Error('Upload path must be absolute without NUL or parent traversal');
    if (this.policy.mode === 'unrestricted') return this.readUnrestricted(absolutePath);
    const normalized = resolve(absolutePath);
    const matches = this.roots.flatMap((root) => [...new Set([root.alias, root.canonical])].map((prefix) => ({ root, prefix, suffix: relative(prefix, normalized) })))
      .filter(({ suffix }) => suffix !== '' && suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix))
      .sort((a, b) => b.prefix.length - a.prefix.length);
    const match = matches[0];
    if (!match) throw new Error('Upload path is outside the configured directories or names a directory');
    return this.readRestricted(match.root, match.suffix.split(sep));
  }

  /** Cancel pending restricted reads, then release every pinned root FD. */
  close(): void {
    this.closed = true;
    for (const cancel of this.children.values()) cancel();
    this.releaseRoots();
  }

  private releaseRoots(): void {
    if (!this.closed || this.children.size) return;
    const roots = this.roots;
    this.roots = [];
    for (const root of roots) { try { closeSync(root.fd); } catch {} }
  }

  private readRestricted(root: Root, parts: string[]): Promise<Buffer> {
    const input = JSON.stringify({ root: root.canonical, parts });
    if (Buffer.byteLength(input) > REQUEST_LIMIT) return Promise.reject(new Error('Upload path is too long'));
    return new Promise((resolveRead, reject) => {
      const child = spawn(this.python!, ['-I', '-S', '-c', RESTRICTED_UPLOAD_WORKER_SOURCE], {
        cwd: '/', shell: false, env: { PATH: PYTHON_PATH }, stdio: ['pipe', 'pipe', 'pipe', root.fd],
      });
      const chunks: Buffer[] = []; let size = 0, stderr = '', stderrSize = 0;
      let failure: Error | undefined;
      const fail = (message: string) => { failure ??= new Error(message); child.kill('SIGKILL'); };
      this.children.set(child, () => fail('Path upload reader is closed'));
      const timeout = setTimeout(() => fail('Restricted upload read timed out'), WORKER_TIMEOUT_MS);
      child.stdout!.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_ATTACHMENT_BYTES) { chunks.length = 0; fail('File exceeds the 5 MiB upload limit'); }
        else if (!failure) chunks.push(chunk);
      });
      child.stderr!.on('data', (chunk: Buffer) => {
        stderrSize += chunk.length;
        if (stderrSize > STDERR_LIMIT) fail('Restricted upload reader failed');
        else stderr += chunk.toString('utf8');
      });
      child.on('error', () => { failure ??= new Error('Could not start restricted upload reader'); });
      child.stdin!.on('error', () => fail('Could not send restricted upload request'));
      child.on('close', (code) => {
        clearTimeout(timeout);
        this.children.delete(child);
        this.releaseRoots();
        if (failure) reject(failure);
        else if (code !== 0 || stderrSize !== 0) reject(new Error(Object.hasOwn(WORKER_ERRORS, stderr) ? WORKER_ERRORS[stderr] : 'Restricted upload reader failed'));
        else resolveRead(Buffer.concat(chunks, size));
      });
      child.stdin!.end(input);
    });
  }

  private async readUnrestricted(path: string): Promise<Buffer> {
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile()) throw new Error('Upload path must name a regular file');
      if (stat.size > MAX_ATTACHMENT_BYTES) throw new Error('File exceeds the 5 MiB upload limit');
      const data = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1); let size = 0;
      while (size < data.length) {
        const { bytesRead } = await file.read(data, size, data.length - size, null);
        if (bytesRead === 0) break;
        size += bytesRead;
      }
      if (size > MAX_ATTACHMENT_BYTES) throw new Error('File exceeds the 5 MiB upload limit');
      return data.subarray(0, size);
    } finally { await file.close(); }
  }
}
