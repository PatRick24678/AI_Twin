import test from 'node:test';
import assert from 'node:assert/strict';
import { createSilenceDetector, VOICE_ACTIVITY } from '../public/voice-activity.js';

// Synthetic level sequences, sampled every 100 ms. They test the rules, not real microphones.
function run(segments, options) {
  const update = createSilenceDetector(options);
  let now = 0, result = 'waiting';
  for (const [level, ms] of segments) {
    for (let t = 0; t < ms; t += 100, now += 100) {
      result = update(level, now);
      if (!['waiting', 'speaking'].includes(result)) return { result, at: now };
    }
  }
  return { result, at: now };
}
const QUIET = 0.005, VOICE = 0.15;

test('speech followed by the configured pause ends the turn', () => {
  const { result, at } = run([[QUIET, 500], [VOICE, 1500], [QUIET, 3000]]);
  assert.equal(result, 'done');
  assert.equal(VOICE_ACTIVITY.silenceMs, 2000);
  // The last voiced sample is at 1900 ms, so 2 s of quiet ends the turn at 3900 ms.
  assert.equal(at, 1900 + VOICE_ACTIVITY.silenceMs);
});

test('thinking pauses shorter than the limit do not end the turn', () => {
  const { result } = run([[QUIET, 500], [VOICE, 800], [QUIET, 1800], [VOICE, 800], [QUIET, 1500]]);
  assert.equal(result, 'speaking');
});

test('a short noise is not speech, and silence alone gives up without sending', () => {
  const spike = run([[QUIET, 500], [VOICE, 200], [QUIET, 3000]]);
  assert.equal(spike.result, 'waiting');
  const silent = run([[QUIET, 9000]]);
  assert.deepEqual(silent, { result: 'no_speech', at: VOICE_ACTIVITY.noSpeechMs });
});

test('a noisy room raises the threshold, and the hard limit stops endless recording', () => {
  // Background at 0.06 would count as speech in a quiet room; after calibration it does not.
  assert.equal(run([[0.06, 9000]]).result, 'no_speech');
  assert.equal(run([[0.06, 400], [0.3, 1000], [0.06, 2500]]).result, 'done');
  assert.deepEqual(run([[QUIET, 300], [VOICE, 61000]]), { result: 'max', at: VOICE_ACTIVITY.maxMs });
});

test('the browser can load the detector as a same-origin script', async t => {
  const { once } = await import('node:events');
  const { createApp } = await import('../server.mjs');
  const server = createApp({ name: 'VOICE-TEST-NO-REAL-API', health: async () => ({ ok: true }) }, null);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/voice-activity.js`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/javascript/);
  assert.match(await response.text(), /export function createSilenceDetector/);
});
