import { fixtureInterviewTurn, completeTestInterview } from '../test-support/interview-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { AnthropicModel, claudeSchema } from '../lib/anthropic-model.mjs';
import { createApp } from '../server.mjs';

const KEY = 'test-only-placeholder-not-a-real-key';
const MODEL = 'claude-haiku-5-5';
const messages = [
  { role: 'system', content: 'Use only confirmed facts.' },
  { role: 'user', content: 'Hello.', source: 'typed' }
];

function streamResponse(text = 'Hello Alex.', { stop = 'end_turn', complete = true, split = false } = {}) {
  const events = [
    { type: 'message_start', message: { usage: { input_tokens: 21, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'ping' },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: stop }, usage: { output_tokens: 9 } },
    ...(complete ? [{ type: 'message_stop' }] : [])
  ];
  const bytes = new TextEncoder().encode(events.map(event =>
    `event: ${event.type}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`).join(''));
  const body = new ReadableStream({ start(controller) {
    // Byte-by-byte splitting exercises fragmented Unicode and CRLF boundaries.
    if (split) for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
    else controller.enqueue(bytes);
    controller.close();
  } });
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

function mock(handler = () => streamResponse()) {
  const calls = [];
  const model = new AnthropicModel({ apiKey: KEY, name: MODEL, fetcher: async (url, options) => {
    calls.push({ url, options });
    return handler(url, options);
  } });
  return { model, calls };
}

test('Claude request keeps system separate, strips metadata and uses bounded non-thinking output', async () => {
  const { model, calls } = mock();
  const chunks = [];
  const result = await model.chat(messages, { onToken: text => chunks.push(text) });
  const request = JSON.parse(calls[0].options.body);
  assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages');
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].options.headers['x-api-key'], KEY);
  assert.equal(request.system, messages[0].content);
  assert.deepEqual(request.messages, [{ role: 'user', content: 'Hello.' }]);
  assert.equal(request.max_tokens, 768);
  assert.deepEqual(request.thinking, { type: 'disabled' });
  assert.ok(!Object.hasOwn(request, 'temperature'));
  assert.equal(chunks.join(''), result.text);
  assert.equal(result.metrics.inputTokens, 21);
  assert.equal(result.metrics.outputTokens, 9); // Cumulative, not 1 + 9.
  assert.ok(!JSON.stringify(model).includes(KEY));
});

test('schema conversion preserves originals and JSON output is not streamed into chat', async () => {
  const schema = { type: 'object', additionalProperties: false, required: ['items'], properties: {
    items: { type: 'array', minItems: 3, maxItems: 3, uniqueItems: true,
      items: { type: 'string', minLength: 2, maxLength: 20 } }
  } };
  const converted = claudeSchema(schema);
  assert.equal(schema.properties.items.minItems, 3);
  assert.equal(converted.properties.items.minItems, 1);
  assert.equal(converted.properties.items.maxItems, undefined);
  assert.equal(converted.properties.items.items.minLength, undefined);
  const { model, calls } = mock(() => streamResponse('{"items":["aa","bb","cc"]}'));
  let chunks = 0;
  const result = await model.chat(messages, { schema, onToken: () => chunks++ });
  const request = JSON.parse(calls[0].options.body);
  assert.equal(request.output_config.format.type, 'json_schema');
  assert.equal(request.max_tokens, 1600);
  assert.equal(chunks, 0);
  assert.equal(JSON.parse(result.text).items.length, 3);
});

test('SSE parser preserves UTF-8 characters across fragmented events', async () => {
  const { model } = mock(() => streamResponse('A €20 example.', { split: true }));
  assert.equal((await model.chat(messages)).text, 'A €20 example.');
});

test('interrupted streams are not returned as completed answers', async () => {
  const { model } = mock(() => streamResponse('Partial.', { complete: false }));
  await assert.rejects(model.chat(messages), /before completion/);
});

test('output truncation is rejected without automatic retries', async () => {
  const { model, calls } = mock(() => streamResponse('Partial.', { stop: 'max_tokens' }));
  await assert.rejects(model.chat(messages), /output limit/);
  assert.equal(calls.length, 1);
});

test('refusals and empty answers do not become valid profile responses', async () => {
  for (const [text, stop] of [['No.', 'refusal'], ['', 'end_turn']]) {
    const { model } = mock(() => streamResponse(text, { stop }));
    await assert.rejects(model.chat(messages));
  }
});

test('provider HTTP failures never expose the raw error or key and are not retried', async () => {
  for (const status of [400, 401, 402, 403, 404, 429, 529]) {
    const { model, calls } = mock(() => new Response(`secret=${KEY}`, { status }));
    await assert.rejects(model.chat(messages), error => {
      assert.ok(!error.message.includes(KEY));
      assert.equal(error.status, status === 429 ? 429 : 502);
      return true;
    });
    assert.equal(calls.length, 1);
  }
});

test('health checks only model metadata, without generation or user content', async () => {
  const { model, calls } = mock(() => Response.json({ type: 'model', id: MODEL }));
  assert.equal((await model.health()).ok, true);
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.body, undefined);
  assert.ok(calls[0].url.endsWith(`/v1/models/${MODEL}`));
});

test('an already cancelled request never reaches the provider', async () => {
  const { model, calls } = mock();
  const controller = new AbortController(); controller.abort();
  await assert.rejects(model.chat(messages, { signal: controller.signal }));
  assert.equal(calls.length, 0);
});

test('cancelling while streaming prevents a completed result', async () => {
  const { model, calls } = mock();
  const controller = new AbortController();
  await assert.rejects(model.chat(messages, {
    signal: controller.signal,
    onToken: () => controller.abort()
  }));
  assert.equal(calls[0].options.signal.aborted, true);
});

test('deadline ends a stalled request without retrying', async () => {
  let calls = 0;
  const hold = setTimeout(() => {}, 2000);
  try {
    const model = new AnthropicModel({ apiKey: KEY, name: MODEL, timeout: 1000,
      fetcher: async (url, options) => new Promise((resolve, reject) => {
        calls++;
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      }) });
    await assert.rejects(model.chat(messages), error => error.status === 504);
    assert.equal(calls, 1);
  } finally { clearTimeout(hold); }
});

test('invalid configuration and oversized prompts fail before network requests', async () => {
  assert.throws(() => new AnthropicModel({ apiKey: '' }));
  assert.throws(() => new AnthropicModel({ apiKey: KEY, name: 'not-approved' }));
  const { model, calls } = mock();
  await assert.rejects(model.chat([{ role: 'user', content: 'x'.repeat(65000) }]));
  assert.equal(calls.length, 0);
});

test('HTTP app journey uses Claude transport while preserving confirmation, buttons and reset', async t => {
  const answers = ['I coordinate projects.', 'I dislike chasing updates.', 'I prefer short messages.', 'I enjoy client conversations.'];
  const { model, calls } = mock((url, options) => {
    if (options.method === 'GET') return Response.json({ type: 'model', id: MODEL });
    const request = JSON.parse(options.body);
    const schema = request.output_config?.format?.schema;
    const fullMessages = [{ role: 'system', content: request.system }, ...request.messages];
    if (schema?.properties?.question) return streamResponse(JSON.stringify(fixtureInterviewTurn(fullMessages)));
    if (schema?.properties?.claims) {
      const { sources } = JSON.parse(request.messages[0].content);
      return streamResponse(JSON.stringify({ claims: sources.slice(0, 3).map(source => ({
        text: source.interpretation || source.text, sourceId: source.id, quote: source.text
      })) }));
    }
    if (schema?.properties?.suggestions) return streamResponse(JSON.stringify({ suggestions: [
      { label: 'What changes about my project updates?', request: 'Explore project coordination in my possible workday.', kind: 'conversation', factIds: ['fact-1'] },
      { label: 'Would I still chase updates?', request: 'Explore the friction involved in chasing updates.', kind: 'conversation', factIds: ['fact-2'] },
      { label: 'Can I keep my messages short?', request: 'Discuss how to retain my concise communication style.', kind: 'conversation', factIds: ['fact-3'] }
    ] }));
    return streamResponse('A possible workday, with fewer reminders to draft.');
  });
  const server = createApp(model);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  let token = '';
  async function call(path, data, method = 'POST') {
    const response = await fetch(base + path, { method,
      headers: { 'Content-Type': 'application/json', 'X-Future-Self': '1', Authorization: `Bearer ${token}` },
      ...(data === undefined ? {} : { body: JSON.stringify(data) })
    });
    assert.equal(response.ok, true, `Unexpected HTTP ${response.status} for ${path}`);
    return response;
  }
  token = (await (await call('/api/session', { name: 'Alex', consent: true })).json()).token;
  await completeTestInterview(base, token, answers);
  const review = await (await call('/api/sample', { text: '', context: '', style: 'none' })).json();
  assert.equal(review.stage, 'review');
  const profile = await (await call('/api/profile', { facts: review.claims.map(c => c.text) })).json();
  const ready = await (await call('/api/suggestions', { profileVersion: profile.profileVersion, mode: 'generate' })).json();
  assert.equal(ready.suggestions.length, 3);
  const wire = await (await call('/api/twin', { action: 'open' })).text();
  const result = wire.trim().split('\n').map(JSON.parse).at(-1);
  assert.equal(result.type, 'done');
  assert.ok(!wire.includes(KEY));
  assert.equal(calls.length, 8); // Opening + four answers + profile + suggestions + twin.
  assert.equal(result.session.metrics.outputTokens, 9);
  const info = await (await call('/api/info', undefined, 'GET')).json();
  assert.ok(!JSON.stringify(info).includes(KEY));
  await call('/api/session', undefined, 'DELETE');
});


test('Sonnet uses its supported between-tools setting rather than Haiku thinking settings', async () => {
  let payload;
  const model = new AnthropicModel({ apiKey: KEY, name: 'claude-sonnet-5-5', fetcher: async (url, options) => {
    payload = JSON.parse(options.body);
    return streamResponse();
  } });
  await model.chat(messages);
  assert.equal(payload.model, 'claude-sonnet-5-5');
  assert.deepEqual(payload.thinking, { type: 'between_tools' });
});
