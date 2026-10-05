import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../server.mjs';
import { replyStyle } from '../lib/reply-style.mjs';
import {
  suggestionMessages,
  suggestionSchema,
  validateSuggestions,
  generateSuggestions
} from '../lib/suggestions.mjs';

// Fictional test fixtures, never a production fallback or template bank.
const facts = [
  'I coordinate projects.',
  'I dislike chasing updates.',
  'I enjoy client conversations.'
];

const context = () => ({
  facts: [...facts],
  sample: null
});

const valid = (hasSample = false) => ({
  suggestions: [
    {
      label: 'Would I still chase updates?',
      request: 'Explore how chasing project updates could change for me.',
      kind: 'conversation',
      factIds: ['fact-2']
    },
    {
      label: hasSample
        ? 'Try my update as a draft'
        : 'What stays mine in project coordination?',
      request: hasSample
        ? 'Draft a clearer version of my supplied project update.'
        : 'Explore what I would still choose to do myself in project coordination.',
      kind: hasSample ? 'draft' : 'conversation',
      factIds: ['fact-1']
    },
    {
      label: 'What about my client conversations?',
      request: 'Explore how I could keep the client conversations I enjoy.',
      kind: 'conversation',
      factIds: ['fact-3']
    }
  ]
});

class FakeModel {
  name = 'TEST-ONLY';
  calls = [];
  outputs = [];
  beforeGenerate = null;

  async chat(messages, { schema, signal, onToken } = {}) {
    const generation = Boolean(schema?.properties?.suggestions);

    this.calls.push({ generation, messages });

    if (generation) {
      await this.beforeGenerate?.(signal);

      const next = this.outputs.length
        ? this.outputs.shift()
        : valid(JSON.parse(messages[1].content).sample.available);

      if (next instanceof Error) throw next;

      return {
        text: typeof next === 'string'
          ? next
          : JSON.stringify(next)
      };
    }

    await onToken?.('A possible workday.');

    return {
      text: 'A possible workday.',
      metrics: {
        firstTokenMs: 1,
        totalMs: 2,
        tokensPerSecond: 3
      }
    };
  }

  get generations() {
    return this.calls.filter(call => call.generation);
  }
}

async function fixture(t) {
  const model = new FakeModel();
  const server = createApp(model);

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  t.after(() => new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections();
  }));

  const base = `http://127.0.0.1:${server.address().port}`;

  async function call(path, data, token = '', method = 'POST') {
    const response = await fetch(base + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Future-Self': '1',
        Authorization: `Bearer ${token}`
      },
      ...(data === undefined
        ? {}
        : { body: JSON.stringify(data) })
    });

    const payload = await response.text();

    return {
      status: response.status,
      body: response.headers.get('content-type')?.includes('ndjson')
        ? payload.trim().split('\n').map(JSON.parse)
        : JSON.parse(payload)
    };
  }

  async function seed(sample) {
    const made = await call('/api/session', {
      name: 'Taylor',
      consent: true
    });

    const token = made.body.token;

    for (const answer of [...facts, 'Direct messages.']) {
      await call('/api/answer', { text: answer }, token);
    }

    const profile = await call(
      '/api/profile',
      {
        facts,
        ...(sample ? { sample } : {})
      },
      token
    );

    assert.equal(profile.body.stage, 'prepare');

    return {
      token,
      version: profile.body.profileVersion
    };
  }

  const prepare = (s, mode = 'generate') =>
    call(
      '/api/suggestions',
      {
        profileVersion: s.version,
        mode
      },
      s.token
    );

  const chat = (s, data = { action: 'open' }) =>
    call('/api/twin', data, s.token);

  return { model, call, seed, prepare, chat };
}

test('suggestion prompt uses confirmed facts, not rejected observations or raw samples', () => {
  const session = {
    ...context(),
    answers: ['REJECTED_DETAIL'],
    claims: [{ text: 'REJECTED_CLAIM' }],
    sample: {
      text: 'PRIVATE_SAMPLE_BODY',
      context: 'Internal update'
    }
  };

  const prompt = JSON.stringify(suggestionMessages(session));

  assert.ok(
    !/REJECTED_DETAIL|REJECTED_CLAIM|PRIVATE_SAMPLE_BODY/.test(prompt)
  );

  const data = JSON.parse(suggestionMessages(session)[1].content);

  assert.equal(data.confirmedFacts[0].id, 'fact-1');
  assert.equal(data.sample.available, true);

  const schema = suggestionSchema(session).properties.suggestions;

  assert.equal(schema.minItems, 3);
  assert.equal(schema.maxItems, 3);
});

test('validation rejects wrong counts, duplicate labels, invented facts and extra fields', () => {
  assert.equal(validateSuggestions(valid(), context()).length, 3);

  const changes = [
    value => value.suggestions.pop(),
    value => {
      value.suggestions[1].label =
        value.suggestions[0].label.toUpperCase();
    },
    value => {
      value.suggestions[0].factIds = ['fact-99'];
    },
    value => {
      value.suggestions[0].request = '';
    },
    value => {
      value.suggestions[0].id = 'model-chosen-id';
    },
    value => {
      value.suggestions[0].label = 'x'.repeat(71);
    }
  ];

  for (const change of changes) {
    const value = valid();
    change(value);

    assert.throws(() =>
      validateSuggestions(value, context())
    );
  }
});

test('exactly one draft requires an available sample', () => {
  assert.throws(() =>
    validateSuggestions(valid(true), context())
  );

  const session = {
    ...context(),
    sample: { text: 'A work example.' }
  };

  assert.throws(() =>
    validateSuggestions(valid(false), session)
  );

  assert.equal(
    validateSuggestions(valid(true), session)
      .filter(s => s.kind === 'draft').length,
    1
  );
});

test('one invalid response is repaired, with server-generated unique IDs', async () => {
  const model = new FakeModel();
  model.outputs = ['not JSON', valid()];

  const result = await generateSuggestions(model, context());

  assert.equal(model.generations.length, 2);
  assert.equal(new Set(result.map(s => s.id)).size, 3);

  assert.match(
    model.generations[1].messages[0].content,
    /previous response was rejected/
  );
});

test('two invalid responses fail without substituting stock buttons', async () => {
  const model = new FakeModel();
  model.outputs = ['bad', 'still bad'];

  await assert.rejects(
    generateSuggestions(model, context()),
    /Retry or continue without buttons/
  );

  assert.equal(model.generations.length, 2);
});

test('connection errors are not automatically retried', async () => {
  const model = new FakeModel();
  model.outputs = [new Error('offline')];

  await assert.rejects(
    generateSuggestions(model, context()),
    /offline/
  );

  assert.equal(model.generations.length, 1);
});

test('chat is gated until preparation, then buttons remain cached across messages', async t => {
  const { seed, prepare, chat, model } = await fixture(t);
  const s = await seed();

  assert.equal((await chat(s)).status, 409);

  const ready = await prepare(s);

  assert.equal(ready.body.suggestions.length, 3);
  assert.equal(ready.body.suggestionStatus, 'ready');
  assert.equal(model.generations.length, 1);

  await chat(s);
  await chat(s, {
    action: 'say',
    text: 'What changes?'
  });

  const cached = await prepare(s);

  assert.deepEqual(
    cached.body.suggestions,
    ready.body.suggestions
  );

  assert.equal(model.generations.length, 1);
});

test('button clicks use stored requests, retain their history and do not change pacing', async t => {
  const { seed, prepare, chat, model } = await fixture(t);
  const s = await seed();

  const ready = await prepare(s);
  const selected = ready.body.suggestions[0];

  await chat(s);

  const response = await chat(s, {
    action: 'suggestion',
    suggestionId: selected.id,
    text: 'UNTRUSTED_REPLACEMENT'
  });

  const done = response.body.at(-1);

  assert.equal(done.type, 'done');

  const message = done.session.messages.find(
    m => m.role === 'user'
  );

  assert.equal(message.content, selected.label);
  assert.equal(message.request, selected.request);
  assert.equal(message.source, 'suggestion');

  assert.equal(
    model.calls.at(-1).messages.at(-1).content,
    selected.request
  );

  assert.ok(
    !JSON.stringify(model.calls.at(-1))
      .includes('UNTRUSTED_REPLACEMENT')
  );

  assert.equal(
    replyStyle({
      answers: facts,
      messages: done.session.messages
    }).sampleSize,
    3
  );

  await chat(s, {
    action: 'say',
    text: 'Why?'
  });

  const history = model.calls.at(-1).messages;

  assert.ok(
    history.some(m => m.content === selected.request)
  );

  assert.ok(
    history.every(
      m => Object.keys(m).sort().join(',') === 'content,role'
    )
  );
});

test('profile correction clears buttons, rejects stale versions and generates a fresh set', async t => {
  const { seed, prepare, chat, call, model } = await fixture(t);
  const s = await seed();

  const old = (await prepare(s)).body.suggestions;

  await chat(s);

  const changed = await call(
    '/api/profile',
    {
      facts: [
        'I enjoy reports.',
        'I dislike gathering inputs.',
        'I keep final judgment.'
      ]
    },
    s.token
  );

  assert.equal(changed.body.stage, 'prepare');
  assert.deepEqual(changed.body.suggestions, []);
  assert.deepEqual(changed.body.messages, []);

  assert.equal((await prepare(s)).status, 409);

  s.version = changed.body.profileVersion;

  const fresh = await prepare(s);

  assert.ok(
    fresh.body.suggestions.every(
      item => !old.some(previous => previous.id === item.id)
    )
  );

  const data = JSON.parse(
    model.generations.at(-1).messages[1].content
  );

  assert.equal(
    data.confirmedFacts[0].text,
    'I enjoy reports.'
  );

  assert.ok(
    !JSON.stringify(data).includes('chasing updates')
  );

  await chat(s);

  assert.equal(
    (await chat(s, {
      action: 'suggestion',
      suggestionId: old[0].id
    })).status,
    400
  );
});

test('explicit skip opens free chat without generic fallback or further generation', async t => {
  const { seed, prepare, chat, model } = await fixture(t);
  const s = await seed();

  const skipped = await prepare(s, 'skip');

  assert.equal(skipped.body.stage, 'twin');
  assert.deepEqual(skipped.body.suggestions, []);
  assert.equal(skipped.body.suggestionStatus, 'skipped');

  assert.equal(
    (await prepare(s)).body.suggestionStatus,
    'skipped'
  );

  assert.equal(model.generations.length, 0);

  assert.equal(
    (await chat(s)).body.at(-1).type,
    'done'
  );
});

test('failed preparation stays recoverable and a later retry can succeed', async t => {
  const { seed, prepare, chat, call, model } = await fixture(t);
  const s = await seed();

  model.outputs = ['bad', 'bad'];

  assert.equal((await prepare(s)).status, 502);

  const state = await call(
    '/api/session',
    undefined,
    s.token,
    'GET'
  );

  assert.equal(state.body.stage, 'prepare');
  assert.deepEqual(state.body.suggestions, []);

  assert.equal((await chat(s)).status, 409);

  assert.equal(
    (await prepare(s)).body.suggestions.length,
    3
  );

  assert.equal(model.generations.length, 3);
});

test('a sample produces one draft button and another session cannot use its IDs', async t => {
  const { seed, prepare, chat } = await fixture(t);

  const a = await seed({
    text: 'The draft is ready.',
    context: 'Internal update',
    style: 'none'
  });

  const buttons = (await prepare(a)).body.suggestions;

  assert.equal(
    buttons.filter(item => item.kind === 'draft').length,
    1
  );

  const b = await seed();

  await prepare(b);
  await chat(b);

  assert.equal(
    (await chat(b, {
      action: 'suggestion',
      suggestionId: buttons[0].id
    })).status,
    400
  );
});

test('reset cancels pending preparation; simultaneous requests cannot overwrite it', async t => {
  const { seed, prepare, call, model } = await fixture(t);
  const s = await seed();

  let started;
  let aborted = false;

  const entered = new Promise(resolve => {
    started = resolve;
  });

  model.beforeGenerate = signal =>
    new Promise((resolve, reject) => {
      started();

      signal.addEventListener(
        'abort',
        () => {
          aborted = true;
          reject(signal.reason);
        },
        { once: true }
      );
    });

  const pending = prepare(s);

  await entered;

  assert.equal((await prepare(s)).status, 409);

  assert.equal(
    (await call(
      '/api/session',
      undefined,
      s.token,
      'DELETE'
    )).status,
    200
  );

  await pending;

  assert.equal(aborted, true);

  assert.equal(
    (await call(
      '/api/session',
      undefined,
      s.token,
      'GET'
    )).status,
    401
  );
});