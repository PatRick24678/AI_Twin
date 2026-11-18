import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createCryptoBox, newDataKey } from '../lib/crypto-box.mjs';
import { openStore, RETENTION } from '../lib/store.mjs';
import { openPostgresStore } from '../lib/store-postgres.mjs';
import { createStore } from '../server.mjs';

// The same behaviour from both stores. SQLite always runs; Postgres only when TEST_DATABASE_URL names a test
// database (a DIRECT, non-pooled connection, e.g. a Neon `dev` branch). Each run uses its own schema and drops it.
// Generated keys and fictional accounts only.
const box = createCryptoBox(newDataKey()), DAY = 24 * 60 * 60 * 1000;
const backends = [['SQLite', now => ({ store: openStore({ path: ':memory:', box, now }), done: async () => {} })]];
if (process.env.TEST_DATABASE_URL) backends.push(['Postgres', now => {
  const store = openPostgresStore({ url: process.env.TEST_DATABASE_URL, box, now, schema: `test_${randomBytes(6).toString('hex')}`, max: 1 });
  return { store, done: async () => { await store.dropSchema(); await store.close(); } };
}]);
const account = (store, email = 'Alex@Example.test', role) => store.createUser({ email, passwordHash: 'scrypt$fake', consentVersion: 'test-1', role });

for (const [name, open] of backends) {
  test(`${name} store: accounts, logins, twins and deletion behave as the app expects`, async t => {
    const { store, done } = open(() => Date.now());
    t.after(done);
    const alex = await account(store);
    assert.equal(alex.email, 'alex@example.test');
    assert.equal(await account(store, ' ALEX@example.test '), null); // Duplicate: a generic null, no error.
    assert.equal((await store.findUserByEmail('alex@EXAMPLE.test')).id, alex.id);
    assert.equal(await store.findUserByEmail('nobody@example.test'), undefined);
    assert.equal(typeof alex.createdAt, 'number');
    await store.createSession({ idHash: 'h1', userId: alex.id, expiresAt: Date.now() + DAY });
    assert.equal((await store.findSession('h1')).userId, alex.id);
    await store.setResetCode(alex.id, 'hash', 123);
    assert.equal((await store.findUser(alex.id)).resetExpires, 123);
    await store.setPassword(alex.id, 'scrypt$new');
    assert.equal(await store.findSession('h1'), undefined); // A new password signs out everywhere.
    assert.equal(await store.loadTwin(alex.id), null);
    await store.saveTwin(alex.id, { name: 'Alex', profile: { entries: ['first'] } });
    await store.saveTwin(alex.id, { name: 'Alex', profile: { entries: ['first', 'second'] } });
    assert.deepEqual(await store.loadTwin(alex.id), { name: 'Alex', profile: { entries: ['first', 'second'] } });
    assert.deepEqual((await store.listUsers()).map(u => [u.email, u.hasTwin]), [['alex@example.test', true]]);
    assert.equal(await store.deleteUser(alex.id), true);
    assert.equal(await store.deleteUser(alex.id), false);
    assert.equal(await store.loadTwin(alex.id), null);
    assert.deepEqual((await store.listAudit()).map(entry => entry.action), ['account_created', 'account_deleted']);
  });

  test(`${name} store: purge and stale twins follow the retention rules`, async t => {
    let clock = Date.parse('2026-01-01');
    const { store, done } = open(() => clock);
    t.after(done);
    const idle = await account(store), admin = await account(store, 'admin@example.test', 'admin');
    await store.saveTwin(idle.id, { name: 'Idle' });
    await store.createSession({ idHash: 'old', userId: admin.id, expiresAt: clock + DAY });
    clock += (RETENTION.unfinishedDays + 1) * DAY;
    assert.deepEqual(await store.staleTwins(RETENTION.unfinishedDays), [idle.id]);
    clock = Date.parse('2026-01-01') + (RETENTION.inactiveDays + 1) * DAY;
    assert.equal(await store.purge(), 1);
    assert.deepEqual([await store.findUser(idle.id), Boolean(await store.findUser(admin.id))], [undefined, true]);
    assert.equal(await store.findSession('old'), undefined);
  });
}

test('createStore picks hosted Postgres when DATABASE_URL is set, and needs the encryption key', async () => {
  const key = newDataKey();
  // Constructing does not connect; the start-up message shows the host only, never the credentials.
  const hosted = createStore({ DATA_ENCRYPTION_KEY: key, DATABASE_URL: 'postgres://user:SECRET@db.example.test/app' });
  assert.equal(hosted.path, 'Postgres at db.example.test');
  assert.ok(!JSON.stringify(hosted).includes('SECRET'));
  await hosted.close();
  assert.equal(createStore({ DATABASE_URL: 'postgres://user:SECRET@db.example.test/app' }), null);
});
