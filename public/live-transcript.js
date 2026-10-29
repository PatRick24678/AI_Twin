// Live transcription helpers (Mistral realtime protocol). Pure functions, no DOM, so they run in Node tests.
export const LIVE = Object.freeze({ rate: 16000, delayMs: 480, chunkMs: 100, finishMs: 5000, characters: 3000 });

// Microphone floats at the device rate → 16 kHz signed 16-bit PCM. Averaging is a simple low-pass before decimating.
export function toPcm16(samples, inputRate, outputRate = LIVE.rate) {
  const ratio = inputRate / outputRate, out = new Int16Array(Math.floor(samples.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const start = Math.floor(i * ratio), end = Math.max(start + 1, Math.min(samples.length, Math.floor((i + 1) * ratio)));
    let sum = 0;
    for (let j = start; j < end; j++) sum += samples[j];
    const value = Math.max(-1, Math.min(1, sum / (end - start)));
    out[i] = value < 0 ? value * 0x8000 : value * 0x7fff;
  }
  return out;
}

// Little-endian bytes, as on every browser platform, base64-encoded for input_audio.append.
export function base64(pcm) {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export const sessionUpdate = (language = 'en') => ({ type: 'session.update', session: {
  audio_format: { encoding: 'pcm_s16le', sample_rate: LIVE.rate }, language, target_streaming_delay_ms: LIVE.delayMs } });
export const appendAudio = pcm => ({ type: 'input_audio.append', audio: base64(pcm) });
export const endAudio = () => ({ type: 'input_audio.end' });

// Deltas are final and appended; "done" carries the full transcript, which replaces the live text.
export const liveStart = () => ({ text: '', done: false, error: '' });
export function reduceLive(state, event) {
  if (event?.type === 'transcription.text.delta' && typeof event.text === 'string') {
    return { ...state, text: (state.text + event.text).slice(0, LIVE.characters) };
  }
  if (event?.type === 'transcription.done') {
    return { ...state, done: true, text: (typeof event.text === 'string' ? event.text : state.text).trim().slice(0, LIVE.characters) };
  }
  if (event?.type === 'error') return { ...state, error: String(event.error?.message || 'Live transcription failed.').slice(0, 200) };
  return state;
}
