import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { replyStyle, wordCount } from '../lib/reply-style.mjs';
import { twinMessages } from '../lib/prompts.mjs';
import { OllamaModel } from '../lib/model.mjs';
import { createApp } from '../server.mjs';

const words = count => Array(count).fill('detail').join(' ');
const typed = content => ({ role: 'user', content, source: 'typed' });

const shortSession = () => ({
  name: 'Taylor',
  answers: [
    'Project coordination.',
    'Chasing updates.',
    'Direct messages.',
    'Client conversations.'
  ],
  facts: [
    'I coordinate projects.',
    'I enjoy client conversations.'
  ],
  messages: [],
  sample: null
});

test('word counting handles punctuation and empty input', () => {
  assert.equal(wordCount("Hi—there! I'm back."), 4);
  assert.equal(wordCount('  '), 0);
  assert.equal(wordCount(null), 0);
});

test('short intake produces a brief default without another model call', () => {
  const result = replyStyle(shortSession());

  assert.equal(result.mode, 'brief');
  assert.equal(result.sampleSize, 4);
  assert.equal(result.medianWords, 2);
});

test('thresholds and the no-evidence fallback are explicit', () => {
  for (const [count, mode] of [
    [12, 'brief'],
    [13, 'balanced'],
    [35, 'balanced'],
    [36, 'expanded']
  ]) {
    assert.equal(
      replyStyle({ answers: [words(count)], messages: [] }).mode,
      mode
    );
  }

  assert.equal(
    replyStyle({ answers: [], messages: [] }).mode,
    'balanced'
  );
});

test('one long message does not overturn consistently short answers', () => {
  assert.equal(
    replyStyle(shortSession(), 'say', words(60)).mode,
    'brief'
  );
});

test('one okay does not permanently replace an expanded default', () => {
  const session = {
    answers: Array(4).fill(words(60)),
    messages: []
  };

  assert.equal(
    replyStyle(session, 'say', 'okay').mode,
    'expanded'
  );
});

test('recent typed messages eventually replace the intake signal', () => {
  const session = {
    answers: Array(4).fill(words(60)),
    messages: Array.from(
      { length: 4 },
      () => typed('Just the essentials.')
    )
  };

  const result = replyStyle(session, 'say', 'What changes?');

  assert.equal(result.mode, 'brief');
  assert.equal(result.sampleSize, 5);
});

test('samples, profile text, buttons and model replies do not count', () => {
  const session = shortSession();
  const before = replyStyle(session);

  session.sample = {
    text: words(300),
    context: words(50)
  };

  session.facts = [words(60)];

  session.messages = [
    {
      role: 'user',
      source: 'suggestion',
      content: words(100)
    },
    {
      role: 'assistant',
      content: words(100)
    },
    {
      role: 'user',
      content: words(100)
    } // Unknown origin: not style evidence.
  ];

  assert.deepEqual(
    replyStyle(session, 'demo', words(100)),
    before
  );
});

test('the current typed message counts without mutating the session', () => {
  const session = {
    answers: [],
    messages: []
  };

  const result = replyStyle(session, 'say', words(50));

  assert.equal(result.mode, 'expanded');
  assert.equal(result.sampleSize, 1);
  assert.deepEqual(session, { answers: [], messages: [] });
});

test('the prompt makes explicit requests override the default and protects draft style', () => {
  const messages = twinMessages(
    shortSession(),
    'say',
    'Explain in detail.'
  );

  assert.match(
    messages[0].content,
    /CONVERSATIONAL PACING — brief default/
  );

  assert.match(
    messages[0].content,
    /CURRENT request for more or less detail takes priority/
  );

  assert.match(
    messages[0].content,
    /does not set a work document's length or formality/
  );

  assert.equal(
    messages.at(-1).content,
    'Explain in detail.'
  );
});

test('message-source metadata is not sent to Ollama', () => {
  const session = shortSession();

  session.messages = [
    typed('Why?'),
    { role: 'assistant', content: 'A reason.' }
  ];

  for (const message of twinMessages(session, 'say', 'Go on.')) {
    assert.deepEqual(
      Object.keys(message).sort(),
      ['content', 'role']
    );
  }
});

// These integration checks use a fake model, NOT actual local inference.
test('HTTP flow tracks origins, ignores failed turns and resets style history with the profile', async t => {
  const calls = [];
  let failNext = false;

  const model = {
    name: 'TEST-ONLY',

    async chat(messages, { onToken } = {}) {
      calls.push(messages);
      await onToken?.('Test answer.');

      if (failNext) {
        failNext = false;
        throw new Error('Simulated failure');
      }

      return {
        text: 'Test answer.',
        metrics: {
          firstTokenMs: 1,
          totalMs: 2,
          tokensPerSecond: 3
        }
      };
    }
  };

  const server = createApp(model);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  t.after(() => new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections();
  }));

  const base = `http://127.0.0.1:${server.address().port}`;
  let token = '';

  async function post(path, data) {
    const response = await fetch(base + path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Future-Self': '1',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify(data)
    });

    assert.ok(
      response.ok,
      `Unexpected HTTP ${response.status} for ${path}`
    );

    return response;
  }

  async function chat(action, text = '') {
    const response = await post('/api/twin', { action, text });

    const events = (await response.text())
      .trim()
      .split('\n')
      .map(JSON.parse);

    return events.at(-1);
  }

  const created = await (
    await post('/api/session', {
      name: 'Taylor',
      consent: true
    })
  ).json();

  token = created.token;

  for (const answer of shortSession().answers) {
    await post('/api/answer', { text: answer });
  }

  await post('/api/profile', {
    facts: shortSession().facts
  });

  assert.equal((await chat('open')).type, 'done');
  assert.match(calls.at(-1)[0].content, /brief default/);

  const clicked = await chat('challenge');

  assert.equal(
    clicked.session.messages.find(m => m.role === 'user').source,
    'suggestion'
  );

  let completed;

  for (let i = 0; i < 3; i++) {
    completed = await chat('say', words(60));
  }

  assert.match(calls.at(-1)[0].content, /expanded default/);

  assert.deepEqual(
    completed.session.messages
      .filter(m => m.role === 'user')
      .map(m => m.source),
    ['suggestion', 'typed', 'typed', 'typed']
  );

  assert.ok(
    calls.flat().every(message => !Object.hasOwn(message, 'source'))
  );

  const beforeFailure = completed.session.messages;
  failNext = true;

  assert.equal(
    (await chat('say', 'Failed message')).type,
    'error'
  );

  const stored = await (
    await fetch(base + '/api/session', {
      headers: {
        Authorization: `Bearer ${token}`
      }
    })
  ).json();

  assert.deepEqual(stored.messages, beforeFailure);

  await post('/api/profile', {
    facts: [
      'I enjoy reports.',
      'I dislike gathering inputs.'
    ]
  });

  assert.equal((await chat('open')).type, 'done');
  assert.match(calls.at(-1)[0].content, /brief default/);
});

test('Ollama uses the larger conversation ceiling without changing the profile ceiling', async t => {
  const requests = [];

  const upstream = http.createServer(async (req, res) => {
    const chunks = [];

    for await (const chunk of req) {
      chunks.push(chunk);
    }

    requests.push(
      JSON.parse(Buffer.concat(chunks).toString())
    );

    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson'
    });

    res.end(JSON.stringify({
      message: { content: '{}' },
      done: true,
      done_reason: 'stop'
    }) + '\n');
  });

  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');

  t.after(() => new Promise(resolve => {
    upstream.close(resolve);
    upstream.closeAllConnections();
  }));

  const model = new OllamaModel({
    base: `http://127.0.0.1:${upstream.address().port}`
  });

  await model.chat([
    { role: 'user', content: 'Hello' }
  ]);

  await model.chat(
    [{ role: 'user', content: 'Profile' }],
    { schema: { type: 'object' } }
  );

  assert.equal(requests[0].options.num_predict, 768);
  assert.equal(requests[1].options.num_predict, 1200);
});