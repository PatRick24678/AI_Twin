import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { RETENTION } from './store.mjs';

// Hosted storage (Neon Postgres, EU). The same async methods and retention rules as the SQLite store in store.mjs.
// Personal content and emails are encrypted (crypto-box.mjs) before they reach the database: it holds ciphertext only.
const DAY = 24 * 60 * 60 * 1000;
const MIGRATIONS = [
  `CREATE TABLE users (
     id TEXT PRIMARY KEY, email_hmac TEXT NOT NULL UNIQUE, email_enc TEXT NOT NULL, password_hash TEXT NOT NULL,
     role TEXT NOT NULL CHECK (role IN ('participant', 'admin')), created_at BIGINT NOT NULL, last_active_at BIGINT NOT NULL,
     consent_version TEXT NOT NULL, consent_at BIGINT NOT NULL, reset_hash TEXT, reset_expires BIGINT);
   CREATE TABLE auth_sessions (
     id_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     created_at BIGINT NOT NULL, expires_at BIGINT NOT NULL, last_seen_at BIGINT NOT NULL);
   CREATE INDEX auth_sessions_user ON auth_sessions (user_id);
   CREATE TABLE twins (
     user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
     data_enc TEXT NOT NULL, schema_version INTEGER NOT NULL, updated_at BIGINT NOT NULL);
   -- Accountability only: who did what to which account, never content.
   CREATE TABLE audit_log (id BIGSERIAL PRIMARY KEY, at BIGINT NOT NULL, actor_id TEXT, action TEXT NOT NULL, target_id TEXT);`
];
// Millisecond timestamps fit safely in a JavaScript number; read BIGINT columns as numbers, not strings.
const BIGINT = { to: 20, from: [20], serialize: value => String(value), parse: value => Number(value) };

// Neon's connection strings carry libpq-only settings (sslmode, channel_binding). postgres.js would send unknown ones
// to the server as session parameters, so they are removed; TLS is set below instead.
const LIBPQ_ONLY = ['sslmode', 'channel_binding', 'sslrootcert', 'sslcert', 'sslkey', 'gssencmode'];
export function connectionUrl(url) {
  const parsed = new URL(url);
  requireProtocol(parsed);
  for (const name of LIBPQ_ONLY) parsed.searchParams.delete(name);
  return parsed.href;
}
function requireProtocol(parsed) {
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) throw new Error('DATABASE_URL must be a postgres:// connection string.');
}

// `url` is DATABASE_URL (never logged). `schema` is for tests only: a private schema on a direct connection.
export function openPostgresStore({ url, box, now = () => Date.now(), schema = '', max = 3 } = {}) {
  if (!box) throw new Error('Saved twins need DATA_ENCRYPTION_KEY.');
  const host = new URL(url).hostname, local = ['localhost', '127.0.0.1'].includes(host);
  const sql = postgres(connectionUrl(url), {
    // Remote databases: encrypted AND the server certificate checked ('require' in postgres.js skips the check).
    ssl: local ? false : 'verify-full', max, idle_timeout: 60, connect_timeout: 15,
    prepare: false, // Works through Neon's connection pooler.
    types: { bigint: BIGINT }, onnotice: () => {},
    ...(schema ? { connection: { search_path: schema } } : {})
  });
  // Migrations run once, before the first query; a failure (e.g. the database still waking) is retried next time.
  let ready = null;
  const prepare = () => (ready ||= (async () => {
    if (schema) await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS "${schema.replace(/"/g, '')}"`);
    await sql.begin(async tx => {
      await tx`SELECT pg_advisory_xact_lock(4171)`;
      await tx`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)`;
      const [row] = await tx`SELECT version FROM schema_version`;
      const version = row?.version ?? 0;
      for (let i = version; i < MIGRATIONS.length; i++) await tx.unsafe(MIGRATIONS[i]).simple(); // Several statements.
      if (!row) await tx`INSERT INTO schema_version (version) VALUES (${MIGRATIONS.length})`;
      else if (version < MIGRATIONS.length) await tx`UPDATE schema_version SET version = ${MIGRATIONS.length}`;
    });
  })().catch(error => { ready = null; throw error; }));
  const query = async (strings, ...values) => { await prepare(); return sql(strings, ...values); };
  const normalEmail = email => email.trim().toLowerCase();
  const user = row => row && { id: row.id, email: box.open(row.email_enc, `email:${row.id}`), passwordHash: row.password_hash,
    role: row.role, createdAt: row.created_at, lastActiveAt: row.last_active_at, consentVersion: row.consent_version,
    resetHash: row.reset_hash, resetExpires: row.reset_expires };

  const store = {
    path: `Postgres at ${host}`, // For the start-up message: the host only, never the credentials.
    ready: prepare,
    async createUser({ email, passwordHash, role = 'participant', consentVersion }) {
      const id = randomUUID(), at = now(), address = normalEmail(email);
      try {
        await query`INSERT INTO users (id, email_hmac, email_enc, password_hash, role, created_at, last_active_at, consent_version, consent_at)
          VALUES (${id}, ${box.lookup(address)}, ${box.seal(address, `email:${id}`)}, ${passwordHash}, ${role}, ${at}, ${at}, ${consentVersion}, ${at})`;
      } catch (error) {
        if (error.code === '23505') return null; // Unique email: the caller answers generically.
        throw error;
      }
      await store.audit(id, 'account_created', id);
      return store.findUser(id);
    },
    findUser: async id => user((await query`SELECT * FROM users WHERE id = ${id}`)[0]),
    findUserByEmail: async email => user((await query`SELECT * FROM users WHERE email_hmac = ${box.lookup(normalEmail(email))}`)[0]),
    touchUser: async id => { await query`UPDATE users SET last_active_at = ${now()} WHERE id = ${id}`; },
    async setPassword(id, passwordHash) {
      await query`UPDATE users SET password_hash = ${passwordHash}, reset_hash = NULL, reset_expires = NULL WHERE id = ${id}`;
      await store.deleteUserSessions(id); // A new password signs out everywhere.
    },
    setResetCode: async (id, hash, expires) => { await query`UPDATE users SET reset_hash = ${hash}, reset_expires = ${expires} WHERE id = ${id}`; },
    // Metadata only, for the admin page: no profile, conversation or interview content.
    listUsers: async () => (await query`SELECT u.*, EXISTS (SELECT 1 FROM twins t WHERE t.user_id = u.id) AS has_twin
      FROM users u ORDER BY u.created_at, u.id`).map(row => ({ id: row.id, email: box.open(row.email_enc, `email:${row.id}`),
        role: row.role, createdAt: row.created_at, lastActiveAt: row.last_active_at, hasTwin: Boolean(row.has_twin) })),

    createSession: async ({ idHash, userId, expiresAt }) => {
      const at = now();
      await query`INSERT INTO auth_sessions (id_hash, user_id, created_at, expires_at, last_seen_at) VALUES (${idHash}, ${userId}, ${at}, ${expiresAt}, ${at})`;
    },
    findSession: async idHash => {
      const [row] = await query`SELECT * FROM auth_sessions WHERE id_hash = ${idHash}`;
      return row && { userId: row.user_id, createdAt: row.created_at, expiresAt: row.expires_at, lastSeenAt: row.last_seen_at };
    },
    touchSession: async idHash => { await query`UPDATE auth_sessions SET last_seen_at = ${now()} WHERE id_hash = ${idHash}`; },
    deleteSession: async idHash => { await query`DELETE FROM auth_sessions WHERE id_hash = ${idHash}`; },
    deleteUserSessions: async userId => { await query`DELETE FROM auth_sessions WHERE user_id = ${userId}`; },

    // One encrypted document per participant, bound to their ID.
    async saveTwin(userId, document, schemaVersion = 1) {
      await query`INSERT INTO twins (user_id, data_enc, schema_version, updated_at)
        VALUES (${userId}, ${box.seal(document, `twin:${userId}`)}, ${schemaVersion}, ${now()})
        ON CONFLICT (user_id) DO UPDATE SET data_enc = excluded.data_enc, schema_version = excluded.schema_version, updated_at = excluded.updated_at`;
    },
    async loadTwin(userId) {
      const [row] = await query`SELECT data_enc FROM twins WHERE user_id = ${userId}`;
      return row ? box.open(row.data_enc, `twin:${userId}`) : null;
    },
    deleteTwin: async userId => { await query`DELETE FROM twins WHERE user_id = ${userId}`; },
    staleTwins: async days => (await query`SELECT user_id FROM twins WHERE updated_at < ${now() - days * DAY}`).map(row => row.user_id),

    // Deletes the account and, through the foreign keys, its sessions and twin.
    async deleteUser(userId, actorId = userId) {
      const removed = (await query`DELETE FROM users WHERE id = ${userId}`).count > 0;
      if (removed) await store.audit(actorId, 'account_deleted', userId);
      return removed;
    },
    // Storage limitation: inactive participant accounts, expired sessions and old audit entries.
    async purge() {
      const at = now();
      const users = await query`SELECT id FROM users WHERE role = 'participant' AND last_active_at < ${at - RETENTION.inactiveDays * DAY}`;
      for (const { id } of users) await store.deleteUser(id, null);
      await query`DELETE FROM auth_sessions WHERE expires_at < ${at}`;
      await query`DELETE FROM audit_log WHERE at < ${at - RETENTION.auditDays * DAY}`;
      return users.length;
    },
    audit: async (actorId, action, targetId = null) => {
      await query`INSERT INTO audit_log (at, actor_id, action, target_id) VALUES (${now()}, ${actorId}, ${action}, ${targetId})`;
    },
    listAudit: async () => (await query`SELECT at, actor_id, action, target_id FROM audit_log ORDER BY id`)
      .map(row => ({ at: row.at, actorId: row.actor_id, action: row.action, targetId: row.target_id })),
    // Tests only: remove the private test schema.
    dropSchema: async () => { if (schema) await sql.unsafe(`DROP SCHEMA IF EXISTS "${schema.replace(/"/g, '')}" CASCADE`); },
    close: () => sql.end({ timeout: 5 })
  };
  return Object.freeze(store);
}
