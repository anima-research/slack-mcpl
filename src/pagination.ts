/** Successful-page budgets, separate from retries and authorization evidence. */
export interface PaginationLimits { conversations: number; users: number; backscroll: number }
export const DEFAULT_PAGINATION: Readonly<PaginationLimits> = Object.freeze({ conversations: 1000, users: 1000, backscroll: 100 });
export const PAGE_SETTINGS = {
  conversations: 'SLACK_CONVERSATION_PAGE_LIMIT',
  users: 'SLACK_USER_PAGE_LIMIT',
  backscroll: 'SLACK_BACKSCROLL_PAGE_LIMIT',
} as const;

export function pageLimit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 10000) {
    throw new Error(`${name} must be a decimal integer from 1 to 10000`);
  }
  return value;
}

export function paginationLimits(values: Partial<PaginationLimits> = {}): Readonly<PaginationLimits> {
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('pagination must be an object containing page limits');
  // A misspelled limit would otherwise fall back to its default silently.
  const unknown = Object.keys(values).filter(key => !Object.hasOwn(PAGE_SETTINGS, key));
  if (unknown.length) throw new Error(`pagination has unknown ${unknown.length === 1 ? 'key' : 'keys'} ${unknown.slice(0, 5).map(key => JSON.stringify(key.slice(0, 40))).join(', ')}; expected conversations, users or backscroll`);
  const result = { ...DEFAULT_PAGINATION };
  for (const key of Object.keys(PAGE_SETTINGS) as Array<keyof PaginationLimits>) {
    const value = values[key];
    result[key] = pageLimit(value === undefined ? DEFAULT_PAGINATION[key] : value, `pagination.${key}`);
  }
  return Object.freeze(result);
}

export function paginationSettings(env: Record<string, string | undefined>): Readonly<PaginationLimits> {
  const values: Partial<PaginationLimits> = {};
  for (const key of Object.keys(PAGE_SETTINGS) as Array<keyof PaginationLimits>) {
    const name = PAGE_SETTINGS[key], raw = env[name];
    if (raw === undefined) continue;
    // A setting's text is canonical: 01, +1 or 1.0 is refused with that said.
    if (!/^[1-9][0-9]*$/.test(raw) || Number(raw) > 10000) throw new Error(`${name} must be a decimal integer from 1 to 10000, written without sign, spaces or leading zeros`);
    values[key] = pageLimit(Number(raw), name);
  }
  return paginationLimits(values);
}

export interface PageTruncation { reason: 'page_limit'; pages: number; limit: number }
export function listingTruncationNote(t: PageTruncation): string {
  return `Incomplete conversation listing: stopped after ${t.pages} Slack pages. Additional conversations may be missing, ` +
    'including joined channels or DMs. This is not a complete workspace inventory. Ask the operator to review the ' +
    'pagination limit; repeating this call with the same limit may return the same subset.';
}

/** A Slack timestamp, a message's ts. */
export const SLACK_TS = /^\d{1,16}(?:\.\d{1,6})?$/;
/** A Slack timestamp this server can place: Slack's form, and a representable
 *  date (no Invalid Date). Policy-mode shaping uses this; legacy backscroll and
 *  incoming events keep main's unchecked parse. */
export const isSlackTimestamp = (value: unknown): value is string =>
  typeof value === 'string' && SLACK_TS.test(value) && Number.isFinite(new Date(Number(value) * 1000).getTime());

const isRecord = (row: unknown): row is Record<string, unknown> => row !== null && typeof row === 'object' && !Array.isArray(row);
const optional = (value: unknown, type: 'string' | 'boolean') => value === undefined || typeof value === type;

/** A conversations.list row: an object with a conversation ID. */
export const isConversationRow = (row: unknown): boolean =>
  isRecord(row) && typeof row.id === 'string' && /^[CGD][A-Z0-9]+$/.test(row.id);
/** A users.list row: a user ID and, where present, fields of their documented types. */
export const isDirectoryRow = (row: unknown): boolean => {
  if (!isRecord(row) || typeof row.id !== 'string' || !/^[UW][A-Z0-9]+$/.test(row.id)) return false;
  if (!optional(row.name, 'string') || !optional(row.real_name, 'string') || !optional(row.deleted, 'boolean') || !optional(row.is_bot, 'boolean')) return false;
  return row.profile == null || (isRecord(row.profile) && optional(row.profile.display_name, 'string'));
};
/** A conversations.history row: a message object with a placeable timestamp. */
export const isHistoryRow = (row: unknown): boolean => isRecord(row) && isSlackTimestamp(row.ts);
/** A conversations.members row: a user ID. */
export const isMemberRow = (row: unknown): boolean => typeof row === 'string' && /^[UW][A-Z0-9]+$/.test(row);

/** Why pageProblem refused a page. */
export type PageProblem = 'container' | 'row' | 'cursor' | 'cycle';

/**
 * The one page validator for explicit-policy scans, run on each page as it
 * arrives, before any of its rows is used and before the scan can return
 * (a match, message or page limit, a candidate's rate limit, a scope restart):
 * the rows are an array of rows `isRow` accepts, and the next cursor is
 * absent or a string (0, null or an object is malformed, not the end) that
 * this scan has not seen before. A valid page's cursor is recorded in `seen`.
 */
export function pageProblem(rows: unknown, next: unknown, seen: Set<string>, isRow: (row: unknown) => boolean): PageProblem | undefined {
  if (!Array.isArray(rows)) return 'container';
  // Indexed, so a hole in an embedder's array is checked too.
  for (let i = 0; i < rows.length; i++) if (!isRow(rows[i])) return 'row';
  if (next !== undefined && typeof next !== 'string') return 'cursor';
  if (next) {
    if (seen.has(next)) return 'cycle';
    seen.add(next);
  }
  return undefined;
}
