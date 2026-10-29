/** Policy-only file evidence. Message references are hints, never authorization. */
import { parseSlackAttachmentUrl } from './content.js';
import { mimeShown, nameShown } from './framing.js';

export const FILE_ID = /^F[A-Z0-9]+$/;
const CONVERSATION_ID = /^[CGD][A-Z0-9]+$/;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const denied = () => new Error('Slack file access could not be verified for this conversation');

/** No raw metadata escapes this check, including the names of other shares.
 * Positive association is sufficient for reading, not proof of exclusive sharing. */
export function associatedFile(value: unknown, fileId: string, channelId: string): Record<string, unknown> {
  if (!FILE_ID.test(fileId) || !CONVERSATION_ID.test(channelId) || !record(value) || value.id !== fileId) throw denied();
  if ((value.is_external !== undefined && value.is_external !== false)
      || (value.mode !== undefined && !['hosted', 'snippet', 'post'].includes(String(value.mode)))) throw denied();
  if (value.deleted === true || value.is_tombstoned === true || value.mode === 'tombstone'
      || value.mode === 'file_access' || (value.file_access !== undefined && value.file_access !== 'visible')) throw denied();
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
  return value;
}

/** Only an authenticated files.info answer may supply the URL. Never echo it on failure. */
export function privateFileUrl(file: Record<string, unknown>): URL {
  if ((file.is_external !== undefined && file.is_external !== false)
      || (file.mode !== undefined && !['hosted', 'snippet', 'post'].includes(String(file.mode)))) throw denied();
  const raw = Object.hasOwn(file, 'url_private_download') ? file.url_private_download : file.url_private;
  if (typeof raw !== 'string' || !raw) throw denied();
  try { return parseSlackAttachmentUrl(raw); } catch { throw denied(); }
}

export interface PolicyFileRef {
  channelId: string;
  fileId?: string;
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
    ...((file.file_access === undefined || file.file_access === 'visible') && typeof file.id === 'string' && FILE_ID.test(file.id) ? { fileId: file.id } : {}),
    name: typeof file.name === 'string' ? file.name : 'attachment',
    ...(typeof file.mimetype === 'string' ? { mimeType: file.mimetype } : {}),
    isImage: typeof file.mimetype === 'string' && file.mimetype.startsWith('image/'),
  }));
}

export function policyFileNote(ref: PolicyFileRef): string {
  return `${nameShown(ref.name)}${ref.mimeType ? ` (${mimeShown(ref.mimeType)})` : ''}` + (ref.fileId
    ? ` — fetch_attachment(${JSON.stringify({ channelId: ref.channelId, fileId: ref.fileId })})`
    : ' — not downloadable: Slack file ID is missing or access is not visible');
}
