import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, savedDocument } from '../server.mjs';
import { createCryptoBox, newDataKey } from '../lib/crypto-box.mjs';
import { openStore } from '../lib/store.mjs';
import { AUTH, checkPassword, hashPassword, verifyPassword, readCookie } from '../lib/auth.mjs';
import { withInterviewFixture } from '../test-support/interview-fixture.mjs';

// Temporary databases, generated keys and fictional accounts only. No model or provider is contacted.
const box = createCryptoBox(newDataKey());
const PASSWORD = 'a fictional long passphrase';
const base = { name: 'ACCOUNTS-TEST-ONLY', health: async () => ({ ok: true }), chat: async () => { throw new Error('unused'); } };

function database(t) {
  const folder = mkdtempSync(join(tmpdir(), 'future-self-accounts-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  return join(folder, 'accounts.db');
}
async function start(t, store) {
  const server = createApp(withInterviewFixture(base), null, store);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const stop = () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  t.after(stop);
  const root = `http://127.0.0.1:${server.address().port}`;
  // A tiny cookie jar: the browser would do this.
  let cookie = '';
  async function call(path, { body, token = '', method = body === undefined ? 'GET' : 'POST', jar = true } = {}) {
    const response = await fetch(root + path, { method, headers: { 'Content-Type': 'application/json', 'X-Future-Self': '1',
      ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(jar && cookie ? { Cookie: `${AUTH.cookie}=${cookie}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const set = response.headers.get('set-cookie');
    if (set) cookie = readCookie(set);
    return { status: response.status, body: await response.json(), setCookie: set };
  }
  return { call, stop, forget: () => { cookie = ''; } };
}
const signup = (call, email = 'alex@example.test') => call('/api/auth/signup', { body: { email, password: PASSWORD, name: 'Alex', consent: true } });

test('passwords are hashed with scrypt and checked for length and predictability', async () => {
  const hash = await hashPassword(PASSWORD);
  assert.match(hash, /^scrypt\$16384\$8\$1\$/);
  assert.ok(!hash.includes(PASSWORD));
  assert.equal(await verifyPassword(PASSWORD, hash), true);
  assert.equal(await verifyPassword('a different passphrase', hash), false);
  assert.equal(await verifyPassword(PASSWORD, undefined), false); // Unknown account: decoy hash, same answer.
  for (const weak of ['short', 'password1234', 'aaaaaaaaaaaaaaaa', 'alex@example.test']) assert.throws(() => checkPassword(weak, 'alex@example.test'));
});

test('sign-up creates an account with a protected login cookie and an empty twin', async t => {
  const store = openStore({ path: ':memory:', box }), { call } = await start(t, store);
  assert.equal((await call('/api/info')).body.accounts, true);
  assert.equal((await call('/api/auth/signup', { body: { email: 'alex@example.test', password: PASSWORD, name: 'Alex' } })).status, 400);
  assert.equal((await call('/api/auth/signup', { body: { email: 'not-an-email', password: PASSWORD, name: 'Alex', consent: true } })).status, 400);
  assert.equal((await call('/api/auth/signup', { body: { email: 'alex@example.test', password: 'short', name: 'Alex', consent: true } })).status, 400);
  const made = await signup(call);
  assert.equal(made.status, 201);
  assert.deepEqual(made.body.user, { email: 'alex@example.test', role: 'participant' });
  assert.equal(made.body.session.name, 'Alex');
  assert.match(made.setCookie, /HttpOnly/); assert.match(made.setCookie, /SameSite=Strict/);
  const user = store.findUserByEmail('alex@example.test');
  assert.equal(user.consentVersion, AUTH.consentVersion);
  assert.ok(!user.passwordHash.includes(PASSWORD));
  assert.equal(store.loadTwin(user.id).name, 'Alex');
  const again = await signup(call, 'ALEX@example.test');
  assert.equal(again.status, 409); assert.doesNotMatch(again.body.error, /exists|taken/);
});

test('login answers the same for unknown emails and wrong passwords, and slows repeated guessing', async t => {
  const store = openStore({ path: ':memory:', box }), { call, forget } = await start(t, store);
  await signup(call); forget();
  const unknown = await call('/api/auth/login', { body: { email: 'nobody@example.test', password: PASSWORD } });
  const wrong = await call('/api/auth/login', { body: { email: 'alex@example.test', password: 'not the right passphrase' } });
  assert.deepEqual([unknown.status, unknown.body], [wrong.status, wrong.body]);
  assert.equal(wrong.body.error, 'Email or password is incorrect.');
  for (let i = 1; i < AUTH.failures; i++) await call('/api/auth/login', { body: { email: 'alex@example.test', password: 'still not right at all' } });
  assert.equal((await call('/api/auth/login', { body: { email: 'alex@example.test', password: PASSWORD } })).status, 429);
});

test('a saved twin resumes after a server restart; the working token alone is not enough', async t => {
  const path = database(t);
  let store = openStore({ path, box }), app = await start(t, store);
  const made = await signup(app.call);
  let state = await app.call('/api/interview/next', { body: { requestId: made.body.session.interview.requestId }, token: made.body.token });
  state = await app.call('/api/answer', { body: { questionId: state.body.interview.questionId, text: 'I coordinate projects.' }, token: made.body.token });
  assert.equal(state.body.interview.turns, 1);
  assert.equal((await app.call('/api/session', { token: made.body.token, jar: false })).status, 401);
  await app.stop(); store.close();

  store = openStore({ path, box }); app = await start(t, store);
  assert.deepEqual((await app.call('/api/auth/me')).body, { user: null });
  const back = await app.call('/api/auth/login', { body: { email: 'alex@example.test', password: PASSWORD } });
  assert.equal(back.status, 200);
  assert.equal(back.body.session.interview.turns, 1);
  assert.ok(back.body.session.intake.some(message => message.content === 'I coordinate projects.'));
  const me = await app.call('/api/auth/me');
  assert.equal(me.body.token, back.body.token); // One working copy per account.
  const out = await app.call('/api/auth/logout', { body: {} });
  assert.match(out.setCookie, /Max-Age=0/);
  assert.equal((await app.call('/api/session', { token: back.body.token })).status, 401);
  assert.deepEqual((await app.call('/api/auth/me')).body, { user: null });
  await app.stop(); store.close(); // Windows keeps an open database file locked.
});

test('an idle login expires', async t => {
  const store = openStore({ path: ':memory:', box, now: () => Date.now() - AUTH.idleMs - 1000 }), { call } = await start(t, store);
  const made = await signup(call);
  assert.deepEqual((await call('/api/auth/me')).body, { user: null });
  assert.equal((await call('/api/session', { token: made.body.token })).status, 401);
});

test('guests are never stored, pasted samples never are, and without a key accounts are off', async t => {
  const store = openStore({ path: ':memory:', box }), { call } = await start(t, store);
  const guest = await call('/api/session', { body: { name: 'Guest', consent: true } });
  await call('/api/interview/next', { body: { requestId: guest.body.session.interview.requestId }, token: guest.body.token });
  assert.deepEqual(store.listUsers(), []);
  const saved = savedDocument({ name: 'A', sample: { text: 'CONFIDENTIAL CLIENT TEXT', context: 'Email' },
    profileDraft: { sample: { text: 'CONFIDENTIAL CLIENT TEXT' } }, controller: {}, metrics: { inputTokens: 1 } });
  assert.ok(!JSON.stringify(saved).includes('CONFIDENTIAL'));
  assert.equal(saved.sample.context, 'Email');
  assert.ok(!('controller' in saved) && !('metrics' in saved));
  const off = await start(t, null);
  assert.equal((await off.call('/api/info')).body.accounts, false);
  assert.equal((await off.call('/api/auth/me')).status, 503);
});
