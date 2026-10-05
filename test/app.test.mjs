import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createApp } from '../server.mjs';
import { groundedClaims, sourcesFor } from '../lib/domain.mjs';
import { OllamaModel } from '../lib/model.mjs';

class FakeModel {
  name = 'TEST-STUB-NOT-A-REAL-MODEL';
  failNext = false;
  calls = [];
  async health() { return { ok: true, model: this.name }; }
  async chat(messages, { schema, onToken } = {}) {
    this.calls.push(messages);
    if (schema) {
      const { sources } = JSON.parse(messages[1].content);
      return { text: JSON.stringify({ claims: sources.slice(0, 3).map(s => ({
        text: s.text, sourceId: s.id, quote: s.text
      })) }), metrics: { firstTokenMs: 1, totalMs: 2, tokensPerSecond: 3 } };
    }
    await onToken?.('A possible ');
    if (this.failNext) { this.failNext = false; throw new Error('Simulated interruption'); }
    await onToken?.('future workday.');
    return { text: 'A possible future workday.',
      metrics: { firstTokenMs: 1, totalMs: 2, tokensPerSecond: 3 } };
  }
}
async function fixture(t, model = new FakeModel()) {
  const server = createApp(model);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function call(path, data, token = '', method = 'POST', extraHeaders = {}) {
    const response = await fetch(base + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Future-Self': '1',
        Authorization: `Bearer ${token}`,
        ...extraHeaders
      },
      ...(data === undefined
        ? {}
        : { body: JSON.stringify(data) })
    });

    const result = {
      status: response.status,
      body: await response.json()
    };

    // These existing tests exercise the conversation, not button generation.
    // After profile confirmation, explicitly skip the buttons so the tests
    // can continue into the twin conversation.
    if (path === '/api/profile' && response.ok) {
      assert.equal(result.body.stage, 'prepare');

      return call(
        '/api/suggestions',
        {
          profileVersion: result.body.profileVersion,
          mode: 'skip'
        },
        token
      );
    }

    return result;
  }
  async function seed(name = 'Taylor') {
    const created = await call('/api/session', { name, consent: true });
    const token = created.body.token;
    for (const answer of ['I coordinate projects.', 'I dislike chasing updates.',
      'I prefer concise writing.', 'I enjoy client conversations.']) {
      assert.equal((await call('/api/answer', { text: answer }, token)).status, 200);
    }
    return token;
  }
  async function stream(token, action = 'open', text = '') {
    const response = await fetch(base + '/api/twin', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Future-Self': '1', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ action, text })
    });
    return (await response.text()).trim().split('\n').map(JSON.parse);
  }
  return { base, model, call, seed, stream };
}
test('full journey, real HTTP streaming, explicit correction, reflection and reset', async t => {
  const { call, seed, stream } = await fixture(t);
  const token = await seed();
  const sample = await call('/api/sample', { text: '', context: '', style: 'direct' }, token);
  assert.equal(sample.body.stage, 'review');
  assert.equal(sample.body.claims.length, 3);
  const profile = await call('/api/profile', { facts: sample.body.claims.map(c => c.text) }, token);
  assert.equal(profile.body.stage, 'twin');
  const opened = await stream(token);
  assert.ok(opened.some(e => e.type === 'token'));
  assert.equal(opened.at(-1).type, 'done');
  await stream(token, 'say', 'What would I still do myself?');
  const corrected = await call('/api/profile', { facts: ['I enjoy writing reports.', 'I dislike gathering inputs.'] }, token);
  assert.deepEqual(corrected.body.messages, []);
  await stream(token);
  assert.equal((await call('/api/finish', { reflection: 'The gathering example felt relevant.' }, token)).body.stage, 'done');
  assert.equal((await call('/api/session', undefined, token, 'DELETE')).status, 200);
  assert.equal((await call('/api/session', undefined, token, 'GET')).status, 401);
});
test('cannot bypass intake or confirmation; input limits enforced', async t => {
  const { call, seed } = await fixture(t);
  const created = await call('/api/session', { name: 'A', consent: true });
  const token = created.body.token;
  assert.equal((await call('/api/twin', { action: 'open' }, token)).status, 409);
  assert.equal((await call('/api/profile', { facts: ['a', 'b'] }, token)).status, 409);
  assert.equal((await call('/api/answer', { text: 'x'.repeat(601) }, token)).status, 400);
  assert.equal((await call('/api/session', { name: 'A', consent: false })).status, 400);
  const ready = await seed();
  assert.equal((await call('/api/profile', { facts: ['one'] }, ready)).status, 400);
});
test('a failed streamed exchange is not stored and can be retried', async t => {
  const { call, seed, stream, model } = await fixture(t);
  const token = await seed();
  await call('/api/profile', { facts: ['I coordinate projects.', 'I prefer short messages.'] }, token);
  await stream(token);
  model.failNext = true;
  const failed = await stream(token, 'say', 'Test failure');
  assert.equal(failed.at(-1).type, 'error');
  assert.equal((await call('/api/session', undefined, token, 'GET')).body.messages.length, 1);
  assert.equal((await stream(token, 'say', 'Retry')).at(-1).type, 'done');
});
test('sessions are isolated; cross-origin requests are rejected', async t => {
  const { call, seed, stream, model } = await fixture(t);
  const a = await seed('Person A'), b = await seed('Person B');
  await call('/api/profile', { facts: ['Private alpha detail.', 'Alpha preference.'] }, a);
  await stream(a);
  await call('/api/profile', { facts: ['Beta task.', 'Beta preference.'] }, b);
  await stream(b);
  assert.ok(!JSON.stringify(model.calls.at(-1)).includes('alpha'));
  assert.equal((await call('/api/session', { name: 'X', consent: true }, '', 'POST',
    { Origin: 'https://unrelated.example' })).status, 403);
});
test('unsupported quotes and fictional reference evidence are discarded', () => {
  const result = groundedClaims({ claims: [
    { text: 'Valid', sourceId: 'answer1', quote: 'I write updates' },
    { text: 'Invented', sourceId: 'answer1', quote: 'I lead 50 people' },
    { text: 'A reference is not my memory', sourceId: 'reference', quote: 'Thursday' }
  ] }, [{ id: 'answer1', text: 'I write updates each week.' }]);
  assert.equal(result.length, 1);
  assert.ok(!sourcesFor({ answers: ['Hello'], sample: {
    text: 'A borrowed sample', authored: false, typical: true, style: 'none'
  } }).some(s => s.id === 'sample'));
});
test('Ollama adapter parses split UTF-8, sends JSON schema, and records real stream metrics', async t => {
  let received;
  const upstream = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    received = JSON.parse(Buffer.concat(chunks).toString());
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    const bytes = Buffer.from(JSON.stringify({ message: { content: '€ hello' }, done: false }) + '\n' +
      JSON.stringify({ message: { content: '' }, done: true, eval_count: 2, eval_duration: 1000000000 }) + '\n');
    const split = bytes.indexOf(Buffer.from('€')) + 1;
    res.write(bytes.subarray(0, split));
    setTimeout(() => res.end(bytes.subarray(split)), 5);
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  t.after(() => new Promise(resolve => { upstream.close(resolve); upstream.closeAllConnections(); }));
  const model = new OllamaModel({ base: `http://127.0.0.1:${upstream.address().port}` });
  const result = await model.chat([{ role: 'user', content: 'Hello' }], { schema: { type: 'object' } });
  assert.equal(result.text, '€ hello');
  assert.equal(result.metrics.tokensPerSecond, 2);
  assert.equal(received.stream, true);
  assert.deepEqual(received.format, { type: 'object' });
  assert.throws(() => new OllamaModel({ base: 'https://example.com' }));
});
