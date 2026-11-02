import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// The ONLY module that knows how data is stored. A hosted EU database later replaces this file,
// keeping the same methods. Personal content is encrypted before it reaches SQL (see crypto-box.mjs).
export const RETENTION = Object.freeze({ inactiveDays: 183, auditDays: 365 });
const DAY = 24 * 60 * 60 * 1000;

// Outside the repo and outside OneDrive: a synced folder would copy personal data to the cloud.
export function defaultDatabasePath(env = process.env) {
  const path = env.FUTURE_SELF_DB || (env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Tatoma', 'AI-Twin', 'data', 'future-self.db'));
  if (!path) throw new Error('Set FUTURE_SELF_DB to a private folder for the database.');
  if (/onedrive|dropbox|google drive|icloud/i.test(path)) throw new Error('The database must not be in a cloud-synced folder.');
  return path;
}

const MIGRATIONS = [
  `CREATE TABLE users (
     id TEXT PRIMARY KEY, email_hmac TEXT NOT NULL UNIQUE, email_enc TEXT NOT NULL, password_hash TEXT NOT NULL,
     role TEXT NOT NULL CHECK (role IN ('participant', 'admin')), created_at INTEGER NOT NULL, last_active_at INTEGER NOT NULL,
     consent_version TEXT NOT NULL, consent_at INTEGER NOT NULL, reset_hash TEXT, reset_expires INTEGER);
   CREATE TABLE auth_sessions (
     id_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL);
   CREATE TABLE twins (
     user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
     data_enc TEXT NOT NULL, schema_version INTEGER NOT NULL, updated_at INTEGER NOT NULL);
   -- Accountability only: who did what to which account, never content.
   CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, actor_id TEXT, action TEXT NOT NULL, target_id TEXT);`
];

export function openStore({ path = defaultDatabasePath(), box, now = () => Date.now() } = {}) {
  if (!box) throw new Error('Saved twins need DATA_ENCRYPTION_KEY. Run npm.cmd run init:storage.');
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  const version = db.prepare('PRAGMA user_version').get().user_version;
  for (let i = version; i < MIGRATIONS.length; i++) {
    db.exec('BEGIN');
    try { db.exec(MIGRATIONS[i]); db.exec(`PRAGMA user_version = ${i + 1}`); db.exec('COMMIT'); }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  const sql = text => db.prepare(text);
  const normalEmail = email => email.trim().toLowerCase();
  const user = row => row && { id: row.id, email: box.open(row.email_enc, `email:${row.id}`), passwordHash: row.password_hash,
    role: row.role, createdAt: row.created_at, lastActiveAt: row.last_active_at, consentVersion: row.consent_version,
    resetHash: row.reset_hash, resetExpires: row.reset_expires };

  return {
    path,
    createUser({ email, passwordHash, role = 'participant', consentVersion }) {
      const id = randomUUID(), at = now(), address = normalEmail(email);
      try {
        sql(`INSERT INTO users (id, email_hmac, email_enc, password_hash, role, created_at, last_active_at, consent_version, consent_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, box.lookup(address), box.seal(address, `email:${id}`), passwordHash, role, at, at, consentVersion, at);
      } catch (error) {
        if (/UNIQUE/.test(error.message)) return null; // The caller answers generically; never reveal which emails exist.
        throw error;
      }
      this.audit(id, 'account_created', id);
      return this.findUser(id);
    },
    findUser: id => user(sql('SELECT * FROM users WHERE id = ?').get(id)),
    findUserByEmail: email => user(sql('SELECT * FROM users WHERE email_hmac = ?').get(box.lookup(normalEmail(email)))),
    touchUser: id => { sql('UPDATE users SET last_active_at = ? WHERE id = ?').run(now(), id); },
    setPassword(id, passwordHash) {
      sql('UPDATE users SET password_hash = ?, reset_hash = NULL, reset_expires = NULL WHERE id = ?').run(passwordHash, id);
      this.deleteUserSessions(id); // A new password signs out everywhere.
    },
    setResetCode: (id, hash, expires) => { sql('UPDATE users SET reset_hash = ?, reset_expires = ? WHERE id = ?').run(hash, expires, id); },
    // Metadata only, for the admin page: no profile, conversation or interview content.
    listUsers: () => sql(`SELECT u.*, EXISTS (SELECT 1 FROM twins t WHERE t.user_id = u.id) AS has_twin
      FROM users u ORDER BY u.created_at`).all().map(row => ({ id: row.id, email: box.open(row.email_enc, `email:${row.id}`),
        role: row.role, createdAt: row.created_at, lastActiveAt: row.last_active_at, hasTwin: Boolean(row.has_twin) })),

    createSession: ({ idHash, userId, expiresAt }) => {
      const at = now();
      sql('INSERT INTO auth_sessions (id_hash, user_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)').run(idHash, userId, at, expiresAt, at);
    },
    findSession: idHash => {
      const row = sql('SELECT * FROM auth_sessions WHERE id_hash = ?').get(idHash);
      return row && { userId: row.user_id, createdAt: row.created_at, expiresAt: row.expires_at, lastSeenAt: row.last_seen_at };
    },
    touchSession: idHash => { sql('UPDATE auth_sessions SET last_seen_at = ? WHERE id_hash = ?').run(now(), idHash); },
    deleteSession: idHash => { sql('DELETE FROM auth_sessions WHERE id_hash = ?').run(idHash); },
    deleteUserSessions: userId => { sql('DELETE FROM auth_sessions WHERE user_id = ?').run(userId); },

    // One encrypted document per participant, bound to their ID.
    saveTwin(userId, document, schemaVersion = 1) {
      sql(`INSERT INTO twins (user_id, data_enc, schema_version, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET data_enc = excluded.data_enc, schema_version = excluded.schema_version, updated_at = excluded.updated_at`)
        .run(userId, box.seal(document, `twin:${userId}`), schemaVersion, now());
    },
    loadTwin(userId) {
      const row = sql('SELECT data_enc FROM twins WHERE user_id = ?').get(userId);
      return row ? box.open(row.data_enc, `twin:${userId}`) : null;
    },
    deleteTwin: userId => { sql('DELETE FROM twins WHERE user_id = ?').run(userId); },

    // Deletes the account and, through the foreign keys, its sessions and twin.
    deleteUser(userId, actorId = userId) {
      const removed = sql('DELETE FROM users WHERE id = ?').run(userId).changes > 0;
      if (removed) this.audit(actorId, 'account_deleted', userId);
      return removed;
    },
    // Storage limitation: inactive participant accounts, expired sessions and old audit entries.
    purge() {
      const at = now();
      const users = sql(`SELECT id FROM users WHERE role = 'participant' AND last_active_at < ?`).all(at - RETENTION.inactiveDays * DAY);
      for (const { id } of users) this.deleteUser(id, null);
      sql('DELETE FROM auth_sessions WHERE expires_at < ?').run(at);
      sql('DELETE FROM audit_log WHERE at < ?').run(at - RETENTION.auditDays * DAY);
      return users.length;
    },
    audit: (actorId, action, targetId = null) => { sql('INSERT INTO audit_log (at, actor_id, action, target_id) VALUES (?, ?, ?, ?)').run(now(), actorId, action, targetId); },
    listAudit: () => sql('SELECT at, actor_id AS actorId, action, target_id AS targetId FROM audit_log ORDER BY id').all().map(row => ({ ...row })),
    close: () => db.close()
  };
}
