import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { createCryptoBox } from '../lib/crypto-box.mjs';
import { openStore } from '../lib/store.mjs';
import { AUTH, checkEmail, checkPassword, hashPassword } from '../lib/auth.mjs';

// Creates a Tatoma admin account. Admins manage accounts but cannot read anyone's content.
// Run: npm.cmd run create-admin   (the password is typed without being shown)
const fail = message => { console.error(`[admin] ${message}`); process.exit(1); };
if (!process.env.DATA_ENCRYPTION_KEY) fail('Run npm.cmd run init:storage first.');

// One line per question (works when typed and when piped); typed password characters are not echoed.
const prompt = createInterface({ input: stdin, output: stdout, terminal: Boolean(stdin.isTTY) });
const lines = prompt[Symbol.asyncIterator](), echo = prompt._writeToOutput?.bind(prompt);
let muted = false;
prompt._writeToOutput = text => { if (!muted) echo?.(text); };
async function ask(question, hide = false) {
  stdout.write(question); muted = hide;
  const { value = '' } = await lines.next();
  muted = false; if (hide) stdout.write('\n');
  return value;
}
try {
  const email = checkEmail(await ask('Admin email: '));
  const password = checkPassword(await ask('Password (12+ characters, hidden): ', true), email);
  if (await ask('Repeat the password: ', true) !== password) fail('The passwords do not match.');
  const store = openStore({ box: createCryptoBox() });
  const user = store.createUser({ email, passwordHash: await hashPassword(password), role: 'admin', consentVersion: AUTH.consentVersion });
  store.close();
  if (!user) fail('An account with this email already exists.');
  console.log('[admin] Admin account created. Log in with it on the welcome screen.');
} catch (error) { fail(error.message); }
finally { prompt.close(); }
