import { AppError, requireThat } from './domain.mjs';

// Speech-to-text for the optional voice mode. Mistral's API processes in the EU by default.
const API = 'https://api.mistral.ai/v1/audio/transcriptions';
// Live transcription: the server mints a short-lived, model-scoped token; the browser streams audio with it.
const SESSIONS = 'https://api.mistral.ai/v1/client/sessions';
const LIVE_URL = 'wss://api.mistral.ai/v1/audio/transcriptions/realtime';
const VOXTRAL = /^voxtral-[a-z0-9.-]{1,60}$/;
// Usable as a WebSocket subprotocol (RFC 7230 token characters).
const LIVE_TOKEN = /^rt_[!#$%&'*+.^_`|~0-9A-Za-z-]{8,2000}$/;
export const SPEECH_LIMITS = Object.freeze({ audioBytes: 2_000_000, seconds: 60, transcriptCharacters: 3000, perSession: 40 });
export const AUDIO_TYPES = Object.freeze({ 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/wav': 'wav' });

function speechFailure(status) {
  const messages = {
    401: 'Speech transcription authentication failed. Check the Mistral key.',
    402: 'Speech transcription billing needs attention in the Mistral console.',
    403: 'This key does not have permission for speech transcription.',
    404: 'The configured transcription model is unavailable to this account.',
    413: 'The recording is too large to transcribe. Record a shorter answer.',
    429: 'Speech transcription rate or spending limit reached. Try again shortly or type your answer.'
  };
  return new AppError(status === 429 ? 429 : 502, messages[status] || 'Speech transcription is unavailable. Type your answer instead.');
}

export class MistralSpeech {
  #key;
  #fetch;

  constructor({
    apiKey = process.env.MISTRAL_API_KEY,
    name = process.env.MISTRAL_STT_MODEL || 'voxtral-mini-latest',
    liveName = process.env.MISTRAL_REALTIME_MODEL || 'voxtral-mini-transcribe-realtime-2602',
    live = process.env.MISTRAL_LIVE !== 'off',
    timeout = 30000,
    fetcher = globalThis.fetch
  } = {}) {
    requireThat(typeof apiKey === 'string' && apiKey.trim() && !/\s/.test(apiKey) && apiKey !== 'PASTE_YOUR_KEY_HERE',
      'Voice input is not configured.', 503);
    requireThat(VOXTRAL.test(name), 'MISTRAL_STT_MODEL must name a Voxtral model.', 503);
    this.#key = apiKey; this.#fetch = fetcher;
    this.name = name; this.timeout = timeout;
    // An invalid realtime model only switches live transcription off; recorded transcription still works.
    this.liveName = liveName; this.live = live && VOXTRAL.test(liveName);
  }

  // A token for ONE live recording. The API key never leaves the server; the token expires after minutes.
  async liveSession({ signal } = {}) {
    requireThat(this.live, 'Live transcription is switched off.', 503);
    const deadline = AbortSignal.timeout(10000);
    const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    let response;
    try {
      response = await this.#fetch(SESSIONS, { method: 'POST', redirect: 'error', signal: requestSignal,
        headers: { Authorization: `Bearer ${this.#key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ purpose: 'realtime', model: this.liveName }) });
    } catch {
      if (signal?.aborted) throw signal.reason;
      throw new AppError(503, 'Could not reach the speech service. Recording still works without live text.');
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw speechFailure(response.status);
    }
    let data;
    try { data = await response.json(); } catch { throw new AppError(502, 'The speech service returned an unreadable response.'); }
    const token = data?.client_secret?.value;
    requireThat(typeof token === 'string' && LIVE_TOKEN.test(token), 'The speech service returned no live session.', 502);
    const expiresAt = data.client_secret.expires_at ?? data.expires_at ?? null;
    return { url: `${LIVE_URL}?model=${encodeURIComponent(this.liveName)}`, token,
      expiresAt: Number.isFinite(expiresAt) ? expiresAt : null };
  }

  // Audio is sent once and never stored or logged here. Only the transcript text is returned.
  async transcribe(audio, { type, signal, language = 'en' } = {}) {
    requireThat(Object.hasOwn(AUDIO_TYPES, type), 'Unsupported audio format.', 415);
    requireThat(audio?.length > 0 && audio.length <= SPEECH_LIMITS.audioBytes, 'The recording is empty or too large.', 413);
    const form = new FormData();
    form.append('model', this.name);
    form.append('language', language);
    form.append('file', new Blob([audio], { type }), `answer.${AUDIO_TYPES[type]}`);
    const deadline = AbortSignal.timeout(this.timeout);
    const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    let response;
    try {
      response = await this.#fetch(API, { method: 'POST', redirect: 'error', signal: requestSignal,
        headers: { Authorization: `Bearer ${this.#key}` }, body: form });
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (deadline.aborted) throw new AppError(504, 'Speech transcription took too long. Try again or type your answer.');
      throw new AppError(503, 'Could not reach the speech service. Check your connection or type your answer.');
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      // Never expose raw provider errors, headers or credentials.
      throw speechFailure(response.status);
    }
    let data;
    try { data = await response.json(); } catch { throw new AppError(502, 'The speech service returned an unreadable response.'); }
    requireThat(data && typeof data.text === 'string', 'The speech service returned no transcript.', 502);
    const seconds = data.usage?.prompt_audio_seconds;
    return { text: data.text.trim().slice(0, SPEECH_LIMITS.transcriptCharacters),
      seconds: Number.isFinite(seconds) ? seconds : null };
  }
}

// Voice is optional: without a key the app runs text-only.
export function createSpeech() {
  if (!process.env.MISTRAL_API_KEY) return null;
  try {
    const speech = new MistralSpeech();
    if (!speech.live && process.env.MISTRAL_LIVE !== 'off') console.warn('[voice] MISTRAL_REALTIME_MODEL must name a Voxtral model. Live transcription is disabled.');
    return speech;
  }
  catch (error) { console.warn(`[voice] ${error.message} Voice input is disabled.`); return null; }
}
