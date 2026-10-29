import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { MistralSpeech, createSpeech, SPEECH_LIMITS } from '../lib/speech-model.mjs';
import { createApp } from '../server.mjs';
import { withInterviewFixture, fixtureInterviewTurn, completeTestInterview } from '../test-support/interview-fixture.mjs';
import { profileSubmission } from '../test-support/profile-fixture.mjs';
import { twinMessages, TWIN_VOICE_MODE } from '../lib/prompts.mjs';
import { interviewMessages, INTERVIEW_VOICE_MODE } from '../lib/interviewer.mjs';
import { createInterview } from '../lib/interview-state.mjs';

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

async function app(t, speech, model) {
  const base = { name: 'SPEECH-TEST-NO-REAL-API', health: async () => ({ ok: true }), chat: async () => { throw new Error('unused'); } };
  const server = createApp(model || withInterviewFixture(base), speech);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const root = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, { token = '', body, type = 'application/json', header = true, method = 'POST' } = {}) => {
    const response = await fetch(root + path, { method,
      headers: { 'Content-Type': type, ...(header ? { 'X-Future-Self': '1' } : {}), Authorization: `Bearer ${token}` },
      ...(body === undefined ? {} : { body: type === 'application/json' ? JSON.stringify(body) : body }) });
    const text = await response.text();
    return { status: response.status, body: (type === 'application/json' && path === '/api/twin') ? text : JSON.parse(text) };
  };
  return { call, root };
}

test('HTTP transcription returns text for a waiting question and never changes the interview', async t => {
  const heard = [];
  const speech = { transcribe: async (bytes, options) => { heard.push({ bytes, type: options.type }); return { text: 'I recruit salespeople.', seconds: 3 }; } };
  const { call } = await app(t, speech);
  // This fake provider has no live transcription, so the browser records and then transcribes.
  assert.deepEqual((await call('/api/info', { method: 'GET' })).body.voice, { available: true, live: false, maxSeconds: SPEECH_LIMITS.seconds });
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

test('voice mode asks both prompts for speakable wording, and only when it is on', () => {
  const session = { name: 'Alex', messages: [], answers: [], facts: ['Recruits salespeople.'], profileVersion: 1 };
  assert.ok(twinMessages(session, 'open', '', { voice: true })[0].content.includes(TWIN_VOICE_MODE));
  assert.ok(!twinMessages(session, 'open')[0].content.includes('VOICE MODE'));
  assert.ok(interviewMessages(createInterview(), '', { voice: true })[0].content.includes(INTERVIEW_VOICE_MODE));
  assert.ok(!interviewMessages(createInterview())[0].content.includes('VOICE MODE'));
});

test('HTTP voice flag reaches the interviewer and the twin; transcription works in the conversation', async t => {
  const prompts = [];
  const model = { name: 'SPEECH-TEST-NO-REAL-API', health: async () => ({ ok: true }),
    async chat(messages, options = {}) {
      prompts.push({ kind: options.schema?.properties?.question ? 'interview' : 'twin', system: messages[0].content });
      const text = options.schema?.properties?.question ? JSON.stringify(fixtureInterviewTurn(messages)) : 'Hello from a possible Tuesday.';
      return { text, metrics: { firstTokenMs: 1, totalMs: 2, inputTokens: 10, outputTokens: 5 } };
    } };
  const speech = { transcribe: async () => ({ text: 'What would I keep doing myself?', seconds: 2 }) };
  const { call, root } = await app(t, speech, model);
  const a = await call('/api/session', { body: { name: 'Alex', consent: true } });
  await call('/api/interview/next', { token: a.body.token, body: { requestId: a.body.session.interview.requestId, voice: true } });
  assert.ok(prompts.at(-1).system.includes(INTERVIEW_VOICE_MODE));
  const b = await call('/api/session', { body: { name: 'Sam', consent: true } });
  const token = b.body.token;
  await completeTestInterview(root, token, ['I recruit salespeople.', 'Replies are slow.', 'Short messages.', 'I keep the interviews.']);
  assert.ok(prompts.filter(p => p.kind === 'interview').slice(1).every(p => !p.system.includes('VOICE MODE')));
  const submission = await profileSubmission(root, token, ['I recruit salespeople.']);
  const profile = await call('/api/profile', { token, body: submission });
  assert.equal(profile.status, 200);
  const twin = await call('/api/suggestions', { token, body: { profileVersion: profile.body.profileVersion, mode: 'skip' } });
  assert.equal(twin.body.stage, 'twin');
  const heard = await call('/api/transcribe', { token, body: audio, type: 'audio/webm' });
  assert.deepEqual(heard, { status: 200, body: { text: 'What would I keep doing myself?' } });
  const wire = await call('/api/twin', { token, body: { action: 'open', voice: true } });
  assert.match(wire.body, /"type":"done"/);
  assert.ok(prompts.at(-1).kind === 'twin' && prompts.at(-1).system.includes(TWIN_VOICE_MODE));
  await call('/api/twin', { token, body: { action: 'say', text: 'What would I keep doing myself?' } });
  assert.ok(!prompts.at(-1).system.includes('VOICE MODE'));
});

test('a live session is minted server-side: model-scoped token out, API key never', async () => {
  const reply = () => new Response(JSON.stringify({ client_secret: { value: 'rt_test-only.token_123', expires_at: 1900000000 } }), { status: 201 });
  const { speech, calls } = mock(reply);
  const result = await speech.liveSession();
  assert.deepEqual(result, { url: 'wss://api.mistral.ai/v1/audio/transcriptions/realtime?model=voxtral-mini-transcribe-realtime-2602',
    token: 'rt_test-only.token_123', expiresAt: 1900000000 });
  assert.ok(!JSON.stringify(result).includes(KEY));
  const { url, options } = calls[0];
  assert.equal(url, 'https://api.mistral.ai/v1/client/sessions');
  assert.equal(options.redirect, 'error');
  assert.equal(options.headers.Authorization, `Bearer ${KEY}`);
  assert.deepEqual(JSON.parse(options.body), { purpose: 'realtime', model: 'voxtral-mini-transcribe-realtime-2602' });
  for (const bad of [{}, { client_secret: { value: KEY } }, { client_secret: { value: 'rt_has space in it' } }, { client_secret: { value: 'rt_a,b' } }]) {
    await assert.rejects(mock(() => Response.json(bad)).speech.liveSession(), /no live session/);
  }
  await assert.rejects(mock(() => new Response(`detail ${KEY}`, { status: 401 })).speech.liveSession(),
    error => /authentication/.test(error.message) && !error.message.includes(KEY));
  assert.equal(new MistralSpeech({ apiKey: KEY, live: false }).live, false);
  assert.equal(new MistralSpeech({ apiKey: KEY, liveName: 'whisper-1' }).live, false); // Recorded transcription still works.
  await assert.rejects(new MistralSpeech({ apiKey: KEY, live: false }).liveSession(), error => error.status === 503);
});

test('HTTP live transcription is gated like recordings, shares their limit and opens only Mistral in the CSP', async t => {
  let minted = 0;
  const speech = { live: true, transcribe: async () => ({ text: 'ok', seconds: 1 }),
    liveSession: async () => { minted += 1; return { url: 'wss://api.mistral.ai/v1/audio/transcriptions/realtime?model=m', token: 'rt_test', expiresAt: null }; } };
  const { call, root } = await app(t, speech);
  assert.equal((await call('/api/info', { method: 'GET' })).body.voice.live, true);
  assert.match((await fetch(root + '/')).headers.get('content-security-policy'), /connect-src 'self' wss:\/\/api\.mistral\.ai;/);
  const made = await call('/api/session', { body: { name: 'Alex', consent: true } }), token = made.body.token;
  assert.equal((await call('/api/transcribe/live', { token, body: {} })).status, 409); // No question waiting yet.
  await call('/api/interview/next', { token, body: { requestId: made.body.session.interview.requestId } });
  assert.equal((await call('/api/transcribe/live', { token, body: {}, header: false })).status, 403);
  assert.deepEqual((await call('/api/transcribe/live', { token, body: {} })).body.token, 'rt_test');
  for (let i = 1; i < SPEECH_LIMITS.perSession; i++) await call('/api/transcribe', { token, body: audio, type: 'audio/webm' });
  assert.equal((await call('/api/transcribe/live', { token, body: {} })).status, 429);
  assert.equal(minted, 1);
});

test('without live transcription the CSP allows only this server', async t => {
  for (const speech of [null, { live: false, transcribe: async () => ({ text: '', seconds: 0 }) }]) {
    const { call, root } = await app(t, speech);
    assert.match((await fetch(root + '/')).headers.get('content-security-policy'), /connect-src 'self';/);
    const made = await call('/api/session', { body: { name: 'Alex', consent: true } });
    assert.equal((await call('/api/transcribe/live', { token: made.body.token, body: {} })).status, 503);
  }
});

test('HTTP voice works for a profile clarification, and only while that question is waiting', async t => {
  const base = { name: 'SPEECH-TEST-NO-REAL-API', health: async () => ({ ok: true }), chat: async (messages, { schema }) => {
    const data = JSON.parse(messages[1].content);
    const entry = data.entries.find(e => e.topic === 'communication');
    return { text: JSON.stringify(schema.properties.sampleNotes ? { sampleNotes: [], clarifications: [{ topic: 'communication',
      question: 'Is that also how you write to clients?', reason: 'Audience may change it.', entryIds: [entry.id], usesSample: false }] }
      : { resolved: false, decisions: [], additions: [] }), metrics: {} };
  } };
  const speech = { transcribe: async () => ({ text: 'Not to clients, no.', seconds: 2 }) };
  const { call, root } = await app(t, speech, withInterviewFixture(base));
  const token = (await call('/api/session', { body: { name: 'Alex', consent: true } })).body.token;
  await completeTestInterview(root, token, ['I coordinate projects.', 'Approvals are slow.', 'I write briefly internally.']);
  const draft = await call('/api/sample', { token, body: { text: '', context: '', style: 'none' } });
  assert.equal(draft.body.stage, 'clarify');
  assert.deepEqual((await call('/api/transcribe', { token, body: audio, type: 'audio/webm' })).body, { text: 'Not to clients, no.' });
  const question = draft.body.profileDraft.questions[0];
  await call('/api/profile/clarify', { token, body: { draftId: draft.body.profileDraft.id, questionId: question.id, kind: 'skip' } });
  assert.equal((await call('/api/transcribe', { token, body: audio, type: 'audio/webm' })).status, 409);
});
