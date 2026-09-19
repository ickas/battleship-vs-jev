/**
 * Whether the server should replace Jev with the code-side density stand-in.
 *
 * This flag decides whether the numbers a run produces are real, so it fails
 * safe in one direction only: anything that is not an explicit, recognised
 * "on" leaves the real model in place. A typo can therefore cost an API call,
 * never the validity of a result.
 *
 * Recognised as on: `1`, `true`, `yes`, in any case, with surrounding
 * whitespace ignored. Unset, empty, `0`, `false`, `no` and anything
 * unrecognised are off.
 */
const ENABLED = /^(1|true|yes)$/i;

export function isMockEnabled(value: string | undefined): boolean {
  return ENABLED.test((value ?? '').trim());
}
