import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createCryptoBox, newDataKey } from '../lib/crypto-box.mjs';
import { openStore, defaultDatabasePath, RETENTION } from '../lib/store.mjs';

// Generated test keys and temporary databases only: no real secrets or participant data.
const box = createCryptoBox(newDataKey());
const DAY = 24 * 60 * 60 * 1000;
function temporary(t) {
  const folder = mkdtempSync(join(tmpdir(), 'future-self-store-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  return join(folder, 'test.db');
}
const account = (store, email = 'Alex@Example.test') => store.createUser({ email, passwordHash: 'scrypt$fake', consentVersion: 'test-1' });

test('encryption round-trips, detects tampering and binds data to its row', () => {
  const sealed = box.seal({ profile: 'Coordinates events' }, 'twin:a');
  assert.deepEqual(box.open(sealed, 'twin:a'), { profile: 'Coordinates events' });
  assert.notEqual(box.seal('same', 'x'), box.seal('same', 'x')); // Fresh nonce each time.
  assert.throws(() => box.open(sealed, 'twin:b'), /integrity/);
  const flipped = sealed.slice(0, -4) + (sealed.at(-4) === 'A' ? 'B' : 'A') + sealed.slice(-3);
  assert.throws(() => box.open(flipped, 'twin:a'), /integrity/);
  assert.throws(() => createCryptoBox(newDataKey()).open(sealed, 'twin:a'), /integrity/);
  assert.equal(box.lookup('alex@example.test'), box.lookup('alex@example.test'));
  assert.notEqual(box.lookup('alex@example.test'), createCryptoBox(newDataKey()).lookup('alex@example.test'));
  for (const bad of [undefined, '', 'short', Buffer.alloc(16).toString('base64')]) assert.throws(() => createCryptoBox(bad), /32 random bytes/);
});

test('the database lives outside the repo and never in a cloud-synced folder', () => {
  assert.equal(defaultDatabasePath({ LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' }),
    join('C:\\Users\\x\\AppData\\Local', 'Tatoma', 'AI-Twin', 'data', 'future-self.db'));
  assert.equal(defaultDatabasePath({ FUTURE_SELF_DB: 'D:\\private\\twins.db' }), 'D:\\private\\twins.db');
  assert.throws(() => defaultDatabasePath({ FUTURE_SELF_DB: 'C:\\Users\\x\\OneDrive\\twins.db' }), /cloud-synced/);
  assert.throws(() => defaultDatabasePath({}), /FUTURE_SELF_DB/);
  assert.throws(() => openStore({ path: ':memory:' }), /DATA_ENCRYPTION_KEY/);
});

test('accounts: unique case-insensitive email, encrypted address, generic duplicate result', () => {
  const store = openStore({ path: ':memory:', box });
  const alex = account(store);
  assert.equal(alex.email, 'alex@example.test');
  assert.equal(alex.role, 'participant');
  assert.equal(account(store, ' ALEX@example.test '), null);
  assert.equal(store.findUserByEmail('alex@EXAMPLE.test').id, alex.id);
  assert.equal(store.findUserByEmail('nobody@example.test'), undefined);
  store.setResetCode(alex.id, 'hash', 123);
  store.createSession({ idHash: 's1', userId: alex.id, expiresAt: Date.now() + DAY });
  store.setPassword(alex.id, 'scrypt$new');
  assert.equal(store.findUser(alex.id).passwordHash, 'scrypt$new');
  assert.equal(store.findUser(alex.id).resetHash, null);
  assert.equal(store.findSession('s1'), undefined); // A new password signs out everywhere.
});

test('twins are saved encrypted, survive a restart and cannot be swapped between accounts', t => {
  const path = temporary(t);
  let store = openStore({ path, box });
  const alex = account(store), sam = account(store, 'sam@example.test');
  store.saveTwin(alex.id, { profile: { entries: ['ALEX_SECRET_DETAIL'] } });
  store.saveTwin(sam.id, { profile: { entries: ['SAM_DETAIL'] } });
  store.saveTwin(alex.id, { profile: { entries: ['ALEX_SECRET_DETAIL', 'second'] } });
  store.close();
  // No personal content or email in the file itself.
  const bytes = readFileSync(path).toString('latin1');
  for (const plain of ['ALEX_SECRET_DETAIL', 'alex@example.test', 'SAM_DETAIL']) assert.ok(!bytes.includes(plain), plain);
  store = openStore({ path, box });
  assert.deepEqual(store.loadTwin(alex.id), { profile: { entries: ['ALEX_SECRET_DETAIL', 'second'] } });
  store.close();
  const raw = new DatabaseSync(path);
  assert.equal(raw.prepare('PRAGMA user_version').get().user_version, 1);
  raw.prepare('UPDATE twins SET data_enc = (SELECT data_enc FROM twins WHERE user_id = ?) WHERE user_id = ?').run(sam.id, alex.id);
  raw.close();
  store = openStore({ path, box });
  assert.throws(() => store.loadTwin(alex.id), /integrity/);
  store.close();
});

test('deleting an account removes its sessions and twin; the audit log keeps no content', () => {
  const store = openStore({ path: ':memory:', box });
  const alex = account(store);
  store.saveTwin(alex.id, { profile: 'x' });
  store.createSession({ idHash: 'h', userId: alex.id, expiresAt: Date.now() + DAY });
  assert.equal(store.listUsers()[0].hasTwin, true);
  assert.ok(!JSON.stringify(store.listUsers()).includes('profile'));
  assert.equal(store.deleteUser(alex.id), true);
  assert.deepEqual([store.findUser(alex.id), store.loadTwin(alex.id), store.findSession('h')], [undefined, null, undefined]);
  assert.deepEqual(store.listAudit().map(a => a.action), ['account_created', 'account_deleted']);
  assert.ok(!JSON.stringify(store.listAudit()).includes('example'));
});

test('purge deletes inactive participants, expired sessions and old audit entries, never admins', () => {
  let clock = Date.parse('2026-01-01');
  const store = openStore({ path: ':memory:', box, now: () => clock });
  const idle = account(store);
  const admin = store.createUser({ email: 'admin@example.test', passwordHash: 'x', role: 'admin', consentVersion: 'test-1' });
  store.createSession({ idHash: 'old', userId: admin.id, expiresAt: clock + DAY });
  clock += (RETENTION.inactiveDays - 1) * DAY;
  const active = account(store, 'active@example.test');
  assert.equal(store.purge(), 0);
  clock += 2 * DAY;
  assert.equal(store.purge(), 1);
  assert.deepEqual([store.findUser(idle.id), Boolean(store.findUser(admin.id)), Boolean(store.findUser(active.id))], [undefined, true, true]);
  assert.equal(store.findSession('old'), undefined);
  clock += RETENTION.auditDays * DAY;
  store.purge();
  // Entries older than the retention window are gone; the one exactly at its edge stays.
  assert.ok(store.listAudit().length > 0);
  assert.ok(store.listAudit().every(entry => entry.at >= clock - RETENTION.auditDays * DAY));
});
