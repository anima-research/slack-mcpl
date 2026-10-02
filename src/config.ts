/** Parse an operator switch. An absent value is off; a present value must
 *  say yes or no so a broken environment template cannot disable a guard. */
export function booleanFlag(name: string, raw: string | undefined): boolean {
  const value = raw?.trim().toLowerCase();
  if (value === undefined || value === 'false' || value === '0' || value === 'no') return false;
  if (value === 'true' || value === '1' || value === 'yes') return true;
  throw new Error(`${name} must be true or false, got "${raw}"`);
}
