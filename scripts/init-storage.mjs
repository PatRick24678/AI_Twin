import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseEnv } from 'node:util';
import { newDataKey } from '../lib/crypto-box.mjs';
import { defaultDatabasePath } from '../lib/store.mjs';

// One-time setup for saved twins: adds DATA_ENCRYPTION_KEY to the external secrets.env and creates the
// private data folder. Never prints the key. Run: npm.cmd run init:storage
// With --production it instead prepares production.env (same folder) for the hosted version: a NEW key, separate
// from the local one, plus a line for the Neon production DATABASE_URL. See docs/DEPLOYMENT.md.
const fail = message => { console.error(`[storage] ${message}`); process.exit(1); };
if (!process.env.LOCALAPPDATA) fail('LOCALAPPDATA is not set. On another host, provide DATA_ENCRYPTION_KEY and FUTURE_SELF_DB yourself.');
const production = process.argv.includes('--production');

const file = join(process.env.LOCALAPPDATA, 'Tatoma', 'AI-Twin', production ? 'production.env' : 'secrets.env');
const name = production ? 'production.env' : 'secrets.env';
let existing = {};
try { if (existsSync(file)) existing = parseEnv(readFileSync(file, 'utf8').replace(/^﻿/, '')); }
catch { fail(`Cannot read or parse ${name}. Fix the file, then run this again.`); }

if (existing.DATA_ENCRYPTION_KEY) {
  console.log(`[storage] DATA_ENCRYPTION_KEY is already configured in ${name}; nothing changed.`);
} else {
  mkdirSync(dirname(file), { recursive: true });
  const separator = existsSync(file) && !readFileSync(file, 'utf8').endsWith('\n') ? '\n' : '';
  appendFileSync(file, `${separator}DATA_ENCRYPTION_KEY=${newDataKey()}\n`, { encoding: 'utf8' });
  console.log(`[storage] Added DATA_ENCRYPTION_KEY to ${name} (value hidden).`);
  console.log(`[storage] Keep a private backup of ${name} (e.g. in a password manager): without this key, saved twins cannot be read.`);
}

if (production) {
  if (!readFileSync(file, 'utf8').includes('DATABASE_URL')) {
    appendFileSync(file, '# Paste the Neon production connection string after the = sign (it contains a password):\nDATABASE_URL=\n', 'utf8');
  }
  console.log(`[storage] Production settings file: ${file}`);
  console.log('[storage] Next: add the Neon production DATABASE_URL to it, then follow docs/DEPLOYMENT.md.');
} else {
  let database;
  try { database = defaultDatabasePath(); } catch (error) { fail(error.message); }
  mkdirSync(dirname(database), { recursive: true });
  console.log(`[storage] Database folder ready: ${dirname(database)}`);
}
