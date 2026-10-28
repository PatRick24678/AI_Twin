import { AppError, requireThat } from './domain.mjs';

// Speech-to-text for the optional voice mode. Mistral's API processes in the EU by default.
const API = 'https://api.mistral.ai/v1/audio/transcriptions';
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
    timeout = 30000,
    fetcher = globalThis.fetch
  } = {}) {
    requireThat(typeof apiKey === 'string' && apiKey.trim() && !/\s/.test(apiKey) && apiKey !== 'PASTE_YOUR_KEY_HERE',
      'Voice input is not configured.', 503);
    requireThat(/^voxtral-[a-z0-9.-]{1,60}$/.test(name), 'MISTRAL_STT_MODEL must name a Voxtral model.', 503);
    this.#key = apiKey; this.#fetch = fetcher;
    this.name = name; this.timeout = timeout;
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
  try { return new MistralSpeech(); }
  catch (error) { console.warn(`[voice] ${error.message} Voice input is disabled.`); return null; }
}
