import { constants, openSync, closeSync, fstatSync, realpathSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { MAX_ATTACHMENT_BYTES, SLACK_MAX_FILE_BYTES } from './content.js';

type PathUploadMode = { mode: 'restricted'; directories: string[] } | { mode: 'unrestricted' };
/** The operator's configuration: `maxBytes` defaults to MAX_ATTACHMENT_BYTES. */
export type PathUploadConfig = PathUploadMode & { maxBytes?: number };
/** A validated policy, with its byte limit always present. */
export type PathUploadPolicy = PathUploadMode & { maxBytes: number };

/** `bytes` in MiB, for messages and the tool's description. */
export function mebibytes(bytes: number): string {
  const mib = Math.round((bytes / (1024 * 1024)) * 100) / 100;
  return `${mib || 'under 0.01'} MiB`;
}

/** Configuration is explicit, copied and frozen; an empty restriction must not
 * accidentally enable access to the whole filesystem. `maxBytes` is optional in
 * both modes: a whole number of bytes from 1 to SLACK_MAX_FILE_BYTES, Slack's
 * own per-file limit, MAX_ATTACHMENT_BYTES when absent. Any other key is
 * refused. */
export function validatePathUploadPolicy(value: unknown): PathUploadPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid path upload policy');
  const config = value as Record<string, unknown>;
  const keys = Reflect.ownKeys(config);
  const allowed = config.mode === 'restricted' ? ['mode', 'directories', 'maxBytes']
    : config.mode === 'unrestricted' ? ['mode', 'maxBytes'] : undefined;
  if (!allowed || (config.mode === 'restricted' && (!keys.includes('directories')
      || !Array.isArray(config.directories) || config.directories.length === 0
      || !config.directories.every((path) => typeof path === 'string' && isAbsolute(path) && !path.includes('\0'))))) {
    throw new Error('Path uploads require unrestricted mode or restricted mode with nonempty absolute directories');
  }
  if (!keys.every((key) => typeof key === 'string' && allowed.includes(key))) {
    throw new Error(`A ${config.mode} path upload policy takes no key but ${allowed.join(', ')}`);
  }
  let maxBytes = MAX_ATTACHMENT_BYTES;
  if (keys.includes('maxBytes')) {
    const limit = config.maxBytes;
    if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > SLACK_MAX_FILE_BYTES) {
      throw new Error(`Path upload maxBytes must be a whole number of bytes from 1 to ${SLACK_MAX_FILE_BYTES} ` +
        "(1 GiB, Slack's per-file limit)");
    }
    maxBytes = limit;
  }
  if (config.mode === 'unrestricted') return Object.freeze({ mode: 'unrestricted', maxBytes });
  const directories = [...config.directories as string[]];
  Object.freeze(directories);
  return Object.freeze({ mode: 'restricted', directories, maxBytes });
}

/** A path upload refused for its size, naming the configured limit. */
function tooLarge(limit: number): Error {
  return new Error(`File exceeds the path upload limit of ${limit} bytes (${mebibytes(limit)})`);
}

const REQUEST_LIMIT = 64 * 1024;
/** How much more an unrestricted read takes at a time once a file has grown
 *  past the size fstat gave. */
const GROWTH_CHUNK = 64 * 1024;
const STDERR_LIMIT = 1024;
const WORKER_TIMEOUT_MS = 5000;
const PYTHON_PATH = '/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin';
const WORKER_ERRORS: Record<string, string> = {
  INVALID: 'Invalid restricted upload path',
  ROOT_CHANGED: 'Configured upload root was replaced or moved',
  OUTSIDE: 'Opened upload file is outside the pinned root or no longer linked',
  NOT_REGULAR: 'Upload path must name a regular file',
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
MAX_LIMIT = ${SLACK_MAX_FILE_BYTES}
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
    canonical, parts, LIMIT = request['root'], request['parts'], request['limit']
    if type(LIMIT) is not int or LIMIT < 1 or LIMIT > MAX_LIMIT: refuse('INVALID')
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

  constructor(policy: PathUploadConfig) {
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
    if (typeof absolutePath !== 'string' || !isAbsolute(absolutePath) || absolutePath.includes('\0')) {
      throw new Error('Upload path must be absolute without NUL');
    }
    if (this.policy.mode === 'unrestricted') return this.readUnrestricted(absolutePath);
    if (absolutePath.split(sep).includes('..')) throw new Error('Restricted upload paths cannot contain parent traversal');
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
    const limit = this.policy.maxBytes;
    const input = JSON.stringify({ root: root.canonical, parts, limit });
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
        if (size > limit) { chunks.length = 0; failure ??= tooLarge(limit); child.kill('SIGKILL'); }
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
        else if (code !== 0 || stderrSize !== 0) {
          reject(stderr === 'TOO_LARGE' ? tooLarge(limit)
            : new Error(Object.hasOwn(WORKER_ERRORS, stderr) ? WORKER_ERRORS[stderr] : 'Restricted upload reader failed'));
        }
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
      const limit = this.policy.maxBytes;
      if (stat.size > limit) throw tooLarge(limit);
      // A buffer of the size fstat gave and one byte more, to see a file that
      // grew; growth is read on in chunks, never past the limit and one byte.
      const chunks: Buffer[] = [];
      let buffer = Buffer.alloc(stat.size + 1), filled = 0, size = 0;
      for (;;) {
        const { bytesRead } = await file.read(buffer, filled, buffer.length - filled, null);
        if (bytesRead === 0) break;
        filled += bytesRead; size += bytesRead;
        if (size > limit) throw tooLarge(limit);
        if (filled === buffer.length) {
          chunks.push(buffer);
          buffer = Buffer.alloc(Math.min(GROWTH_CHUNK, limit + 1 - size)); filled = 0;
        }
      }
      chunks.push(buffer.subarray(0, filled));
      return chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks, size);
    } finally { await file.close(); }
  }
}
