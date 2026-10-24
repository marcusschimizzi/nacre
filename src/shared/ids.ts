import { monotonicFactory } from 'ulid';

/**
 * Type prefixes for ids generated in the app (spec §4): `tok_01J…`, `act_01J…`. ULIDs sort by
 * time and make the type of any id in a log or link obvious. Agent ids stay plain names
 * (`claude-code`), and `jobs` uses a bigserial.
 */
export type IdPrefix =
  | 'tok'
  | 'act'
  | 'evt'
  | 'run'
  | 'clm'
  | 'spn'
  | 'blf'
  | 'blv'
  | 'ent'
  | 'mcl'
  | 'cli'
  | 'grt';

// Monotonic: ids made in the same millisecond still sort in creation order.
const nextUlid = monotonicFactory();

export const newId = (prefix: IdPrefix): string => `${prefix}_${nextUlid()}`;

/** Crockford base32, 26 characters: what `ulid` produces. */
export const ULID_PATTERN = '[0-9A-HJKMNP-TV-Z]{26}';
