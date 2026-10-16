import { AppError, requireThat } from './domain.mjs';

const API = 'https://api.anthropic.com';

// Adapt the schemas this prototype uses to Claude's supported subset.
// The original schemas and application validators remain unchanged.
export function claudeSchema(schema) {
  const copy = structuredClone(schema);
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    const hints = [];
    for (const key of ['minLength', 'maxLength', 'maxItems', 'uniqueItems']) {
      if (Object.hasOwn(node, key)) {
        hints.push(`${key}: ${node[key]}`);
        delete node[key];
      }
    }
    if (typeof node.minItems === 'number' && node.minItems > 1) {
      hints.push(`minItems: ${node.minItems}`);
      node.minItems = 1;
    }
    if (hints.length) {
      node.description = [node.description, `Application requirements: ${hints.join('; ')}.`]
        .filter(Boolean).join(' ');
    }
    for (const child of Object.values(node.properties || {})) visit(child);
    if (node.items) visit(node.items);
  }
  visit(copy);
  return copy;
}

// Decode SSE, including fragmented UTF-8, CRLF and multiple data lines.
async function* readEvents(body) {
  requireThat(body, 'Claude returned no response stream.', 502);
  const reader = body.getReader(), decoder = new TextDecoder();
  let buffer = '', data = [];
  function line(value) {
    value = value.replace(/\r$/, '');
    if (value.startsWith('data:')) data.push(value.slice(5).replace(/^ /, ''));
    if (value !== '' || !data.length) return null;
    const joined = data.join('\n'); data = [];
    try { return JSON.parse(joined); }
    catch { throw new AppError(502, 'Claude returned an invalid stream event.'); }
  }
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      requireThat(buffer.length + data.join('').length < 200000,
        'Claude stream exceeded the event-size limit.', 502);
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const event = line(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
        if (event) yield event;
      }
      if (done) break;
    }
    // Do not accept an unterminated event as a completed response.
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function httpFailure(status) {
  const messages = {
    400: 'Claude rejected the request. Check model settings and billing in the Console.',
    401: 'Claude authentication failed. Check whether the key is valid or expired.',
    402: 'Claude billing needs attention. Check the AI Twin workspace in the Console.',
    403: 'This key does not have permission for the requested Claude resource.',
    404: 'The configured Claude model was not found or is unavailable to this account.',
    429: 'Claude rate or spending limit reached. Check the workspace before retrying.'
  };
  return new AppError(status === 429 ? 429 : 502,
    messages[status] || 'Claude is unavailable. Please try again later.');
}

export class AnthropicModel {
  #key;
  #fetch;

  constructor({
    name = process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5',
    apiKey = process.env.ANTHROPIC_API_KEY,
    timeout = Number(process.env.ANTHROPIC_TIMEOUT_MS || 120000),
    fetcher = globalThis.fetch
  } = {}) {
    requireThat(typeof apiKey === 'string' && apiKey.trim() &&
      !/\s/.test(apiKey) && apiKey !== 'PASTE_YOUR_KEY_HERE',
      'Missing API key. Run npm.cmd run check:secrets first.', 503);
    requireThat(['claude-haiku-5-5', 'claude-sonnet-5-5'].includes(name),
      'This adapter is configured for claude-haiku-5-5 or claude-sonnet-5-5.', 503);
    requireThat(Number.isInteger(timeout) && timeout >= 1000 && timeout <= 180000,
      'ANTHROPIC_TIMEOUT_MS must be between 1000 and 180000.', 503);
    this.#key = apiKey;
    this.#fetch = fetcher;
    this.name = name;
    this.timeout = timeout;
  }

  async #request(path, payload, signal) {
    // Fixed HTTPS destination; no redirects, retries, or arbitrary base URL.
    const response = await this.#fetch(API + path, {
      method: payload ? 'POST' : 'GET',
      redirect: 'error', signal,
      headers: {
        'x-api-key': this.#key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      ...(payload ? { body: JSON.stringify(payload) } : {})
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      // Never expose raw provider errors, headers, or credentials.
      throw httpFailure(response.status);
    }
    return response;
  }

  async health() {
    try {
      // Model metadata only: no user content and no text generation.
      const response = await this.#request(
        `/v1/models/${encodeURIComponent(this.name)}`, undefined,
        AbortSignal.timeout(15000)
      );
      const data = await response.json();
      requireThat(data.type === 'model' && typeof data.id === 'string',
        'Unexpected model metadata from Claude.', 502);
      return { ok: true, model: data.id, provider: 'Anthropic' };
    } catch (error) {
      return { ok: false, model: this.name, error: error instanceof AppError
        ? error.message : 'Could not reach Claude. Check your connection.' };
    }
  }

  async chat(messages, { schema, onToken, signal, maxOutputTokens = schema ? 1600 : 768 } = {}) {
    requireThat(Number.isInteger(maxOutputTokens) && maxOutputTokens >= 1 && maxOutputTokens <= 4096,
      'Invalid server-side output-token limit.');
    signal?.throwIfAborted();
    requireThat(Array.isArray(messages) && messages.length > 0 && messages.every(m =>
      m && ['system', 'user', 'assistant'].includes(m.role) &&
      typeof m.content === 'string' && m.content.trim()), 'Invalid model messages.');

    const conversation = messages.filter(m => m.role !== 'system')
      .map(({ role, content }) => ({ role, content }));
    requireThat(conversation[0]?.role === 'user' && conversation.at(-1)?.role === 'user',
      'The model request must begin and end with a user message.');
    const payload = {
      model: this.name,
      system: messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n'),
      messages: conversation,
      max_tokens: maxOutputTokens,
      thinking: { type: this.name === 'claude-sonnet-5-5' ? 'between_tools' : 'disabled' },
      stream: true,
      ...(schema ? { output_config: { format: {
        type: 'json_schema', schema: claudeSchema(schema)
      } } } : {})
    };
    requireThat(Buffer.byteLength(JSON.stringify(payload)) <= 64000,
      'Request too large for this prototype. Shorten the sample or conversation.');

    const deadline = AbortSignal.timeout(this.timeout);
    const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const started = performance.now();
    let text = '', firstTokenMs = null, stopReason = null;
    let began = false, complete = false, usage = {};
    try {
      const response = await this.#request('/v1/messages', payload, requestSignal);
      if (!response.headers.get('content-type')?.includes('text/event-stream')) {
        await response.body?.cancel().catch(() => {});
        throw new AppError(502, 'Claude did not return an event stream.');
      }
      for await (const event of readEvents(response.body)) {
        requestSignal.throwIfAborted();
        if (event.type === 'error') {
          throw new AppError(502, 'Claude interrupted the response. Please retry.');
        }
        if (event.type === 'message_start') {
          began = true; usage = { ...event.message?.usage };
        }
        let chunk = '';
        if (event.type === 'content_block_start' && event.content_block?.type === 'text') {
          chunk = event.content_block.text || '';
        }
        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
          chunk = event.delta.text || '';
        }
        if (chunk) {
          if (firstTokenMs === null) firstTokenMs = Math.round(performance.now() - started);
          text += chunk;
          requireThat(text.length <= 16000, 'Claude response exceeded the size limit.', 502);
          // Profiles and buttons stay buffered; only ordinary dialogue streams to the UI.
          if (!schema && onToken) await onToken(chunk);
        }
        if (event.type === 'message_delta') {
          stopReason = event.delta?.stop_reason ?? stopReason;
          usage = { ...usage, ...event.usage }; // Cumulative values, not increments.
        }
        if (event.type === 'message_stop') { complete = true; break; }
      }
      requestSignal.throwIfAborted();
      requireThat(began && complete, 'Claude stream ended before completion. Retry.', 502);
      requireThat(stopReason !== 'max_tokens', 'Claude reached the output limit. Request a shorter result.', 502);
      requireThat(stopReason !== 'refusal', 'Claude declined this request. Try different fictional input.', 422);
      requireThat(stopReason === 'end_turn' && text.trim(), 'Claude did not produce a complete text answer.', 502);
      return {
        text: text.trim(),
        metrics: {
          firstTokenMs, totalMs: Math.round(performance.now() - started),
          tokensPerSecond: null,
          inputTokens: usage.input_tokens ?? null,
          outputTokens: usage.output_tokens ?? null,
          cacheReadTokens: usage.cache_read_input_tokens ?? 0,
          cacheWriteTokens: usage.cache_creation_input_tokens ?? 0
        }
      };
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (deadline.aborted) throw new AppError(504, 'Claude took too long. Please try again.');
      if (error instanceof AppError) throw error;
      throw new AppError(503, 'Could not complete the Claude request. Check your connection.');
    }
  }
}
