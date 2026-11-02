import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseEnv } from 'node:util';
import { newDataKey } from '../lib/crypto-box.mjs';
import { defaultDatabasePath } from '../lib/store.mjs';

// One-time setup for saved twins: adds DATA_ENCRYPTION_KEY to the external secrets.env and creates the
// private data folder. Never prints the key. Run: npm.cmd run init:storage
const fail = message => { console.error(`[storage] ${message}`); process.exit(1); };
if (!process.env.LOCALAPPDATA) fail('LOCALAPPDATA is not set. On another host, provide DATA_ENCRYPTION_KEY and FUTURE_SELF_DB yourself.');

const secrets = join(process.env.LOCALAPPDATA, 'Tatoma', 'AI-Twin', 'secrets.env');
let existing = {};
try { if (existsSync(secrets)) existing = parseEnv(readFileSync(secrets, 'utf8').replace(/^﻿/, '')); }
catch { fail('Cannot read or parse secrets.env. Fix the file, then run this again.'); }

if (existing.DATA_ENCRYPTION_KEY) {
  console.log('[storage] DATA_ENCRYPTION_KEY is already configured; nothing changed.');
} else {
  mkdirSync(dirname(secrets), { recursive: true });
  const separator = existsSync(secrets) && !readFileSync(secrets, 'utf8').endsWith('\n') ? '\n' : '';
  appendFileSync(secrets, `${separator}DATA_ENCRYPTION_KEY=${newDataKey()}\n`, { encoding: 'utf8' });
  console.log('[storage] Added DATA_ENCRYPTION_KEY to secrets.env (value hidden).');
  console.log('[storage] Keep a private backup of secrets.env: without this key, saved twins cannot be read.');
}

let database;
try { database = defaultDatabasePath(); } catch (error) { fail(error.message); }
mkdirSync(dirname(database), { recursive: true });
console.log(`[storage] Database folder ready: ${dirname(database)}`);
