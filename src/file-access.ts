/** Policy-only file evidence. Message references are hints, never authorization. */
import { SlackFileUnavailable, SlackFileAccessUnverified } from './access-policy.js';
import { classifyExtension, parseSlackAttachmentUrl } from './content.js';
import { mimeShown, nameShown } from './framing.js';

export const FILE_ID = /^F[A-Z0-9]+$/;
const CONVERSATION_ID = /^[CGD][A-Z0-9]+$/;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const denied = () => new SlackFileAccessUnverified('Slack file access could not be verified for this conversation (identity, state, association or download evidence)');

const supportedMode = (mode: unknown) => typeof mode === 'string' && ['hosted', 'snippet', 'post'].includes(mode);
const availableFileState = (file: Record<string, unknown>) =>
  (file.is_external === undefined || file.is_external === false)
  && (file.deleted === undefined || file.deleted === false)
  && (file.is_tombstoned === undefined || file.is_tombstoned === false);

/** Authenticated metadata gate; requires a supported hosted mode and positive association; omitted visibility/deletion flags are accepted unless explicitly restrictive. */
function readableFileState(file: Record<string, unknown>): boolean {
  return supportedMode(file.mode) && availableFileState(file)
    && (file.file_access === undefined || file.file_access === 'visible');
}

/** Confirmed restrictive states are not missing evidence and retrying unchanged
 * cannot make them readable. Malformed/absent state remains unverified. */
function requireReadableFileState(file: Record<string, unknown>): void {
  if (file.deleted === true || file.is_tombstoned === true || file.is_external === true
      || (typeof file.mode === 'string' && file.mode.length > 0 && !supportedMode(file.mode))) {
    throw new SlackFileUnavailable('This file is deleted, tombstoned, external or in an unsupported mode; ask its sender to share a supported file in this conversation');
  }
  if (!readableFileState(file)) throw denied();
}

/** Returns validated raw metadata for adapter-internal use; does not redact other shares.
 * Callers must not expose the result directly.
 * Positive association is sufficient for reading, not proof of exclusive sharing. */
export function associatedFile(value: unknown, fileId: string, channelId: string): Record<string, unknown> {
  if (!FILE_ID.test(fileId) || !CONVERSATION_ID.test(channelId) || !record(value) || value.id !== fileId) throw denied();
  let associated = false;
  for (const key of ['channels', 'groups', 'ims']) {
    const list = value[key];
    if (list === undefined) continue;
    if (!Array.isArray(list) || !Array.from(list).every((id) => typeof id === 'string' && CONVERSATION_ID.test(id))) throw denied();
    if (list.includes(channelId)) associated = true;
  }
  if (value.shares !== undefined) {
    if (!record(value.shares)) throw denied();
    for (const kind of ['public', 'private']) {
      const shares = value.shares[kind];
      if (shares === undefined) continue;
      if (!record(shares)) throw denied();
      for (const [id, entries] of Object.entries(shares)) {
        if (!CONVERSATION_ID.test(id) || !Array.isArray(entries)
            || !Array.from(entries).every((entry) => record(entry) && typeof entry.ts === 'string' && /^\d+\.\d+$/.test(entry.ts))) throw denied();
        if (id === channelId && entries.length > 0) associated = true;
      }
    }
  }
  if (!associated) throw denied();
  requireReadableFileState(value);
  return value;
}

/** Only an authenticated files.info answer may supply the URL. Never echo it on failure. */
export function privateFileUrl(file: Record<string, unknown>): URL {
  requireReadableFileState(file);
  const raw = Object.hasOwn(file, 'url_private_download') ? file.url_private_download : file.url_private;
  if (typeof raw !== 'string' || !raw) throw denied();
  try { return parseSlackAttachmentUrl(raw); } catch { throw denied(); }
}

export interface PolicyFileRef {
  channelId: string;
  fileId?: string;
  downloadUnavailable?: 'files:read';
  name: string;
  mimeType?: string;
  isImage: boolean;
  path?: never;
  url?: never;
}

/** Only metadata already present on the admitted message. No URL extraction or lookup. */
export function policyFileRefs(files: unknown, channelId: string): PolicyFileRef[] {
  if (!Array.isArray(files)) return [];
  return files.filter(record).map((file) => ({
    channelId,
    ...((readableFileState(file) || (file.file_access === 'check_file_info' && availableFileState(file)
      && (file.mode === undefined || supportedMode(file.mode)))) && typeof file.id === 'string' && FILE_ID.test(file.id) ? { fileId: file.id } : {}),
    name: typeof file.name === 'string' ? file.name : 'attachment',
    ...(typeof file.mimetype === 'string' ? { mimeType: file.mimetype } : {}),
    isImage: typeof file.mimetype === 'string' && file.mimetype ? file.mimetype.startsWith('image/')
      : classifyExtension(typeof file.name === 'string' ? file.name : 'attachment').isImage,
  }));
}

export function policyFileNote(ref: PolicyFileRef): string {
  return `${nameShown(ref.name)}${ref.mimeType ? ` (${mimeShown(ref.mimeType)})` : ''}` + (ref.fileId
    ? ` — fetch_attachment(${JSON.stringify({ channelId: ref.channelId, fileId: ref.fileId })})`
    : ref.downloadUnavailable === 'files:read'
      ? ' — not downloadable: required file access is missing or unverified. Ask whoever runs this host to restore file access, then re-read the message for a current attachment reference.'
      : ' — not downloadable: file state or association is unavailable or unverified; ask its sender to share a supported file here, then re-read its message');
}

/** Legacy attachments can carry unrelated channelId metadata; existing URL/path
 * references remain legacy even when that extra property is present. */
export function isPolicyFileRef(value: { channelId?: unknown; path?: unknown; url?: unknown }): value is PolicyFileRef {
  return typeof value.channelId === 'string' && typeof value.path !== 'string' && typeof value.url !== 'string';
}
