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
  const result = { ...DEFAULT_PAGINATION };
  for (const key of Object.keys(PAGE_SETTINGS) as Array<keyof PaginationLimits>) {
    const value = values[key];
    result[key] = pageLimit(value === undefined ? DEFAULT_PAGINATION[key] : value, PAGE_SETTINGS[key]);
  }
  return Object.freeze(result);
}

export function paginationSettings(env: Record<string, string | undefined>): Readonly<PaginationLimits> {
  const values: Partial<PaginationLimits> = {};
  for (const key of Object.keys(PAGE_SETTINGS) as Array<keyof PaginationLimits>) {
    const name = PAGE_SETTINGS[key], raw = env[name];
    if (raw === undefined) continue;
    if (!/^[1-9][0-9]*$/.test(raw)) throw new Error(`${name} must be a decimal integer from 1 to 10000`);
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
