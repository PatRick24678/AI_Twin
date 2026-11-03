import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';

function stop(message) {
  // Never print credential values or raw file contents.
  console.error(`[secrets] ${message}`);
  process.exit(1);
}

// Read the external secrets file only when a key is not already in the environment.
// `required` is true while the Claude key is still missing; the speech key is optional.
function readSecretsFile(required) {
  const localAppData = process.env.LOCALAPPDATA;

  if (!localAppData) {
    if (required) {
      stop(
        'Set ANTHROPIC_API_KEY through your host, or configure the Windows local secrets file.'
      );
    }
    return {};
  }

  const filePath = join(
    localAppData,
    'Tatoma',
    'AI-Twin',
    'secrets.env'
  );

  let contents;

  try {
    // Remove an optional UTF-8 byte-order mark.
    contents = readFileSync(filePath, 'utf8')
      .replace(/^﻿/, '');
  } catch (error) {
    if (!required) return {};

    if (error.code === 'ENOENT') {
      stop(
        'Missing file: %LOCALAPPDATA%\\Tatoma\\AI-Twin\\secrets.env'
      );
    }

    stop(
      'Cannot read the local secrets file. Check its access permissions.'
    );
  }

  try {
    return parseEnv(contents);
  } catch {
    if (!required) return {};

    stop(
      'Cannot parse secrets.env. Use NAME=value with one key per line.'
    );
  }
}

// An existing environment variable takes priority.
// This also supports a hosting service supplying the keys later.
let apiKey = process.env.ANTHROPIC_API_KEY?.trim();
let speechKey = process.env.MISTRAL_API_KEY?.trim();
let dataKey = process.env.DATA_ENCRYPTION_KEY?.trim();
let imageKey = process.env.OPENAI_API_KEY?.trim();

if (!apiKey || !speechKey || !dataKey || !imageKey) {
  const secrets = readSecretsFile(!apiKey);

  // Read only the credentials we need.
  apiKey ||= secrets.ANTHROPIC_API_KEY?.trim();
  speechKey ||= secrets.MISTRAL_API_KEY?.trim();
  dataKey ||= secrets.DATA_ENCRYPTION_KEY?.trim();
  imageKey ||= secrets.OPENAI_API_KEY?.trim();
}

if (
  !apiKey ||
  apiKey === 'PASTE_YOUR_KEY_HERE' ||
  /\s/.test(apiKey)
) {
  stop(
    'ANTHROPIC_API_KEY is missing, still a placeholder, or contains whitespace.'
  );
}

// Make the keys available to the backend without printing them.
process.env.ANTHROPIC_API_KEY = apiKey;

// Optional: voice input stays disabled without a valid speech key.
if (
  speechKey &&
  speechKey !== 'PASTE_YOUR_KEY_HERE' &&
  !/\s/.test(speechKey)
) {
  process.env.MISTRAL_API_KEY = speechKey;
} else {
  if (speechKey) {
    console.warn(
      '[secrets] MISTRAL_API_KEY is a placeholder or contains whitespace; voice input is disabled.'
    );
  }

  delete process.env.MISTRAL_API_KEY;
}

// Optional: saved accounts need the storage key (npm.cmd run init:storage). Without it the app is guest-only.
if (dataKey && Buffer.from(dataKey, 'base64').length === 32) {
  process.env.DATA_ENCRYPTION_KEY = dataKey;
} else {
  if (dataKey) console.warn('[secrets] DATA_ENCRYPTION_KEY is not 32 bytes of base64; saved accounts are disabled.');
  delete process.env.DATA_ENCRYPTION_KEY;
}

// Optional: the future self's face (OpenAI image model). Without a valid key the face feature stays hidden.
if (imageKey && imageKey !== 'PASTE_YOUR_KEY_HERE' && !/\s/.test(imageKey)) {
  process.env.OPENAI_API_KEY = imageKey;
} else {
  if (imageKey) console.warn('[secrets] OPENAI_API_KEY is a placeholder or contains whitespace; character pictures are disabled.');
  delete process.env.OPENAI_API_KEY;
}
