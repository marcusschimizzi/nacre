import * as crypto from 'node:crypto';

/**
 * The owner password (spec §9.3, §11): stored only as an argon2id PHC string in
 * `OWNER_PASSWORD_HASH`, made by `nacre owner-password hash`. Node 24's built-in argon2 (24.7+),
 * no native dependency. The async form runs on the libuv pool, so a consent check doesn't block
 * the event loop.
 */
function argon2Async(algorithm: 'argon2id', params: crypto.Argon2Parameters): Promise<Buffer> {
  // Looked up at call time, not imported by name: on an older Node a named import fails the whole
  // module (and so the api) at load, with an error that doesn't say why.
  if (typeof crypto.argon2 !== 'function') {
    throw new Error(
      `argon2 needs Node 24.7 or later; this is Node ${process.version} (see .node-version)`,
    );
  }
  return new Promise((resolve, reject) =>
    crypto.argon2(algorithm, params, (err, tag) => (err ? reject(err) : resolve(tag))),
  );
}

export interface Argon2Params {
  /** KiB. */
  memory: number;
  passes: number;
  parallelism: number;
}

/** RFC 9106 §4, second recommended option: 64 MiB, 3 passes, 4 lanes. */
export const DEFAULT_ARGON2_PARAMS: Argon2Params = { memory: 65536, passes: 3, parallelism: 4 };

export const MIN_OWNER_PASSWORD_LENGTH = 12;

const SALT_BYTES = 16;
const TAG_BYTES = 32;
// Caps keep a mistyped variable from asking for gigabytes on every consent.
const MAX = { memory: 1_048_576, passes: 16, parallelism: 16 };

// PHC strings use standard base64 without padding.
const B64 = '[A-Za-z0-9+/]+';
const PHC = new RegExp(`^\\$argon2id\\$v=19\\$m=(\\d+),t=(\\d+),p=(\\d+)\\$(${B64})\\$(${B64})$`);

interface ParsedHash extends Argon2Params {
  salt: Buffer;
  tag: Buffer;
}

function parsePhc(phc: string): ParsedHash | null {
  const m = PHC.exec(phc);
  if (!m) return null;
  const [memory, passes, parallelism] = [m[1], m[2], m[3]].map(Number) as [number, number, number];
  const salt = Buffer.from(m[4] ?? '', 'base64');
  const tag = Buffer.from(m[5] ?? '', 'base64');
  const ok =
    passes >= 1 &&
    passes <= MAX.passes &&
    parallelism >= 1 &&
    parallelism <= MAX.parallelism &&
    memory >= 8 * parallelism &&
    memory <= MAX.memory &&
    salt.length >= 8 &&
    tag.length >= 16;
  return ok ? { memory, passes, parallelism, salt, tag } : null;
}

/** True for an argon2id (v=19) PHC string with sane parameters; the config check uses it. */
export const isArgon2idPhc = (value: string): boolean => parsePhc(value) !== null;

const b64 = (buf: Buffer): string => buf.toString('base64').replace(/=+$/, '');

export async function hashOwnerPassword(
  password: string,
  params: Argon2Params = DEFAULT_ARGON2_PARAMS,
): Promise<string> {
  const salt = crypto.randomBytes(SALT_BYTES);
  const tag = await argon2Async('argon2id', {
    message: password,
    nonce: salt,
    tagLength: TAG_BYTES,
    ...params,
  });
  return `$argon2id$v=19$m=${params.memory},t=${params.passes},p=${params.parallelism}$${b64(salt)}$${b64(tag)}`;
}

/** Recompute with the stored parameters and compare in constant time. False for a bad hash. */
export async function verifyOwnerPassword(phc: string, password: string): Promise<boolean> {
  const parsed = parsePhc(phc);
  if (!parsed) return false;
  const tag = await argon2Async('argon2id', {
    message: password,
    nonce: parsed.salt,
    tagLength: parsed.tag.length,
    memory: parsed.memory,
    passes: parsed.passes,
    parallelism: parsed.parallelism,
  });
  return crypto.timingSafeEqual(tag, parsed.tag);
}
