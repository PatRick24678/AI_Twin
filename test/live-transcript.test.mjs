import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { LIVE, toPcm16, base64, sessionUpdate, appendAudio, endAudio, liveStart, reduceLive } from '../public/live-transcript.js';
import { createApp } from '../server.mjs';

// Synthetic samples and events: these test the conversion and protocol handling, not Mistral itself.
test('microphone audio becomes 16 kHz signed 16-bit PCM, clipped and base64-encoded', () => {
  const pcm = toPcm16(new Float32Array(4800).fill(0.5), 48000);
  assert.equal(pcm.length, 1600); // 100 ms at 16 kHz.
  assert.equal(pcm[0], Math.trunc(0.5 * 0x7fff));
  assert.deepEqual([...toPcm16(Float32Array.from([2, 2, 2, -2, -2, -2]), 48000)], [0x7fff, -0x8000]);
  assert.equal(toPcm16(new Float32Array(441), 44100).length, 160);
  const bytes = Buffer.from(base64(Int16Array.from([1, -2, 0x7fff])), 'base64');
  assert.deepEqual([...new Int16Array(bytes.buffer, bytes.byteOffset, 3)], [1, -2, 0x7fff]);
});

test('client messages follow the realtime protocol', () => {
  assert.deepEqual(sessionUpdate(), { type: 'session.update', session: {
    audio_format: { encoding: 'pcm_s16le', sample_rate: 16000 }, language: 'en', target_streaming_delay_ms: 480 } });
  assert.deepEqual(appendAudio(Int16Array.from([0, 1])), { type: 'input_audio.append', audio: 'AAABAA==' });
  assert.deepEqual(endAudio(), { type: 'input_audio.end' });
});

test('deltas build the live text; the final transcript replaces it; errors are recorded', () => {
  let state = liveStart();
  for (const text of ['I coordinate', ' events', ' for a', ' consultancy']) state = reduceLive(state, { type: 'transcription.text.delta', text });
  assert.equal(state.text, 'I coordinate events for a consultancy');
  state = reduceLive(state, { type: 'session.updated', session: {} });
  assert.equal(state.done, false);
  state = reduceLive(state, { type: 'transcription.done', text: ' I coordinate events for a consultancy. ' });
  assert.deepEqual(state, { text: 'I coordinate events for a consultancy.', done: true, error: '' });
  assert.equal(reduceLive(liveStart(), { type: 'error', error: { message: 'Bad audio', code: 1 } }).error, 'Bad audio');
  assert.equal(reduceLive(liveStart(), { type: 'transcription.text.delta', text: 'x'.repeat(5000) }).text.length, LIVE.characters);
});

test('the browser can load the live transcription scripts from this server', async t => {
  const server = createApp({ name: 'LIVE-TEST-NO-REAL-API', health: async () => ({ ok: true }) }, null);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  for (const [path, pattern] of [['/live-transcript.js', /export function reduceLive/], ['/pcm-worklet.js', /registerProcessor\('pcm-capture'/]]) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^text\/javascript/);
    assert.match(await response.text(), pattern);
  }
});
