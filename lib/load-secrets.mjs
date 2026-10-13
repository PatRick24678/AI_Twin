import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';

function stop(message) {
  // Never print credential values or raw file contents.
  console.error(`[secrets] ${message}`);
  process.exit(1);
}

// An existing environment variable takes priority.
// This also supports a hosting service supplying the key later.
let apiKey = process.env.ANTHROPIC_API_KEY?.trim();

if (!apiKey) {
  const localAppData = process.env.LOCALAPPDATA;

  if (!localAppData) {
    stop(
      'Set ANTHROPIC_API_KEY through your host, or configure the Windows local secrets file.'
    );
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
      .replace(/^\uFEFF/, '');
  } catch (error) {
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
    // Read only the credential we need.
    apiKey = parseEnv(contents).ANTHROPIC_API_KEY?.trim();
  } catch {
    stop(
      'Cannot parse secrets.env. Use ANTHROPIC_API_KEY=your_key on one line.'
    );
  }
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

// Make the key available to the backend without printing it.
process.env.ANTHROPIC_API_KEY = apiKey;