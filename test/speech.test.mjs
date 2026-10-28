import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { MistralSpeech, createSpeech, SPEECH_LIMITS } from '../lib/speech-model.mjs';
import { createApp } from '../server.mjs';
import { withInterviewFixture } from '../test-support/interview-fixture.mjs';

// Fake key and fetchers only: these tests never contact a speech provider.
const KEY = 'test-only-speech-key';
const audio = Buffer.from('fake-webm-bytes');
function mock(reply = () => Response.json({ text: '  I recruit salespeople.  ', usage: { prompt_audio_seconds: 4.2 } })) {
  const calls = [];
  const speech = new MistralSpeech({ apiKey: KEY, fetcher: async (url, options) => { calls.push({ url, options }); return reply(url, options); } });
  return { speech, calls };
}

test('transcription sends one multipart request and returns only the trimmed text', async () => {
  const { speech, calls } = mock();
  const result = await speech.transcribe(audio, { type: 'audio/webm' });
  assert.deepEqual(result, { text: 'I recruit salespeople.', seconds: 4.2 });
  assert.equal(calls.length, 1);
  const { url, options } = calls[0];
  assert.equal(url, 'https://api.mistral.ai/v1/audio/transcriptions');
  assert.equal(options.method, 'POST');
  assert.equal(options.redirect, 'error');
  assert.equal(options.headers.Authorization, `Bearer ${KEY}`);
  assert.equal(options.body.get('model'), 'voxtral-mini-latest');
  assert.equal(options.body.get('language'), 'en');
  const file = options.body.get('file');
  assert.equal(file.type, 'audio/webm');
  assert.equal(file.name, 'answer.webm');
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), audio);
});

test('provider failures are safe messages without raw bodies or the key', async () => {
  for (const [status, pattern] of [[401, /authentication/], [429, /rate or spending/], [500, /unavailable/]]) {
    const { speech } = mock(() => new Response(`secret detail ${KEY}`, { status }));
    await assert.rejects(speech.transcribe(audio, { type: 'audio/webm' }), error =>
      pattern.test(error.message) && !error.message.includes(KEY) && !error.message.includes('secret detail'));
  }
  await assert.rejects(mock(() => new Response('not json')).speech.transcribe(audio, { type: 'audio/webm' }), /unreadable/);
  await assert.rejects(mock(() => Response.json({ nope: 1 })).speech.transcribe(audio, { type: 'audio/webm' }), /no transcript/);
  await assert.rejects(mock(() => { throw new Error(`network ${KEY}`); }).speech.transcribe(audio, { type: 'audio/webm' }),
    error => error.status === 503 && !error.message.includes(KEY));
});

test('formats, sizes and configuration are checked before any request', async () => {
  const { speech, calls } = mock();
  await assert.rejects(speech.transcribe(audio, { type: 'video/mp4' }), error => error.status === 415);
  await assert.rejects(speech.transcribe(Buffer.alloc(0), { type: 'audio/webm' }), error => error.status === 413);
  await assert.rejects(speech.transcribe(Buffer.alloc(SPEECH_LIMITS.audioBytes + 1), { type: 'audio/webm' }), error => error.status === 413);
  assert.equal(calls.length, 0);
  assert.throws(() => new MistralSpeech({ apiKey: '' }));
  assert.throws(() => new MistralSpeech({ apiKey: 'has space' }));
  assert.throws(() => new MistralSpeech({ apiKey: KEY, name: 'gpt-4o-transcribe' }));
  const saved = process.env.MISTRAL_API_KEY;
  delete process.env.MISTRAL_API_KEY;
  try { assert.equal(createSpeech(), null); } // Voice is optional; no key means text-only.
  finally { if (saved !== undefined) process.env.MISTRAL_API_KEY = saved; }
});

test('a long transcript is capped and a cancelled request does not return text', async () => {
  const { speech } = mock(() => Response.json({ text: 'x'.repeat(SPEECH_LIMITS.transcriptCharacters + 50) }));
  assert.equal((await speech.transcribe(audio, { type: 'audio/webm' })).text.length, SPEECH_LIMITS.transcriptCharacters);
  const controller = new AbortController();
  const slow = mock((url, options) => new Promise((resolve, reject) =>
    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })));
  const pending = slow.speech.transcribe(audio, { type: 'audio/webm', signal: controller.signal });
  controller.abort();
  await assert.rejects(pending);
});

async function app(t, speech) {
  const base = { name: 'SPEECH-TEST-NO-REAL-API', health: async () => ({ ok: true }), chat: async () => { throw new Error('unused'); } };
  const server = createApp(withInterviewFixture(base), speech);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const root = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, { token = '', body, type = 'application/json', header = true, method = 'POST' } = {}) => {
    const response = await fetch(root + path, { method,
      headers: { 'Content-Type': type, ...(header ? { 'X-Future-Self': '1' } : {}), Authorization: `Bearer ${token}` },
      ...(body === undefined ? {} : { body: type === 'application/json' ? JSON.stringify(body) : body }) });
    return { status: response.status, body: await response.json() };
  };
  return { call };
}

test('HTTP transcription returns text for a waiting question and never changes the interview', async t => {
  const heard = [];
  const speech = { transcribe: async (bytes, options) => { heard.push({ bytes, type: options.type }); return { text: 'I recruit salespeople.', seconds: 3 }; } };
  const { call } = await app(t, speech);
  assert.deepEqual((await call('/api/info', { method: 'GET' })).body.voice, { available: true, maxSeconds: SPEECH_LIMITS.seconds });
  const made = await call('/api/session', { body: { name: 'Alex', consent: true } });
  const token = made.body.token;
  const early = await call('/api/transcribe', { token, body: audio, type: 'audio/webm' });
  assert.equal(early.status, 409); // The opening question has not been generated yet.
  const opened = await call('/api/interview/next', { token, body: { requestId: made.body.session.interview.requestId } });
  const before = JSON.stringify(opened.body);
  const result = await call('/api/transcribe', { token, body: audio, type: 'audio/webm;codecs=opus' });
  assert.deepEqual(result, { status: 200, body: { text: 'I recruit salespeople.' } });
  assert.equal(heard[0].type, 'audio/webm');
  assert.deepEqual(heard[0].bytes, audio);
  const after = (await call('/api/session', { token, method: 'GET' })).body;
  assert.equal(JSON.stringify(after), before); // Not an answer until the participant sends it.
  assert.ok(!JSON.stringify(after).includes('salespeople'));
});

test('HTTP transcription checks session, header, format, size, limit and configuration', async t => {
  const speech = { transcribe: async () => ({ text: 'ok', seconds: 1 }) };
  const { call } = await app(t, speech);
  const made = await call('/api/session', { body: { name: 'Alex', consent: true } });
  const token = made.body.token;
  await call('/api/interview/next', { token, body: { requestId: made.body.session.interview.requestId } });
  assert.equal((await call('/api/transcribe', { body: audio, type: 'audio/webm' })).status, 401);
  assert.equal((await call('/api/transcribe', { token, body: audio, type: 'audio/webm', header: false })).status, 403);
  assert.equal((await call('/api/transcribe', { token, body: audio, type: 'text/plain' })).status, 415);
  assert.equal((await call('/api/transcribe', { token, body: Buffer.alloc(SPEECH_LIMITS.audioBytes + 1), type: 'audio/webm' })).status, 413);
  for (let i = 0; i < SPEECH_LIMITS.perSession; i++) await call('/api/transcribe', { token, body: audio, type: 'audio/webm' });
  assert.equal((await call('/api/transcribe', { token, body: audio, type: 'audio/webm' })).status, 429);
});

test('without a speech provider the app stays text-only', async t => {
  const { call } = await app(t, null);
  assert.equal((await call('/api/info', { method: 'GET' })).body.voice.available, false);
  const made = await call('/api/session', { body: { name: 'Alex', consent: true } });
  const result = await call('/api/transcribe', { token: made.body.token, body: audio, type: 'audio/webm' });
  assert.equal(result.status, 503);
});
