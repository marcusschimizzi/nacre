import { hashOwnerPassword, MIN_OWNER_PASSWORD_LENGTH } from '../shared/password.js';
import { UsageError } from './token.js';

/**
 * `nacre owner-password hash`: prints the argon2id PHC string for `OWNER_PASSWORD_HASH` (spec
 * §12.1) and nothing else on stdout. The password comes from a no-echo prompt (typed twice), or
 * from stdin when piped. Neither the password nor the hash is ever logged.
 */
export async function hash(): Promise<void> {
  let password: string;
  if (process.stdin.isTTY) {
    password = await promptHidden('Owner password: ');
    if ((await promptHidden('Again: ')) !== password) throw new UsageError('the passwords differ');
  } else {
    let piped = '';
    for await (const chunk of process.stdin) piped += String(chunk);
    password = piped.replace(/\r?\n$/, '');
  }
  if ([...password].length < MIN_OWNER_PASSWORD_LENGTH) {
    throw new UsageError(
      `the owner password must be at least ${MIN_OWNER_PASSWORD_LENGTH} characters`,
    );
  }
  process.stdout.write(`${await hashOwnerPassword(password)}\n`);
  console.error(
    'Set this as OWNER_PASSWORD_HASH on the api service (a raw value, not a reference).',
  );
}

/** Reads one line from the terminal without echoing it. Ctrl-C cancels. */
function promptHidden(question: string): Promise<string> {
  const stdin = process.stdin;
  process.stderr.write(question);
  stdin.setRawMode(true);
  stdin.setEncoding('utf8');
  stdin.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const finish = () => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stderr.write('\n');
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          finish();
          resolve(value);
          return;
        }
        if (ch === '\u0003' || ch === '\u0004') {
          finish();
          reject(new UsageError('cancelled'));
          return;
        }
        // Backspace (DEL or BS) removes one character; nothing is echoed either way.
        if (ch === '\u007f' || ch === '\b') value = [...value].slice(0, -1).join('');
        else value += ch;
      }
    };
    stdin.on('data', onData);
  });
}
