import { AppError, requireThat } from './domain.mjs';

// Handles split JSON lines AND split UTF-8 characters. Used for Ollama's real stream.
export async function* ndjson(body) {
  requireThat(body, 'The model returned no response stream.', 502);
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      requireThat(buffer.length < 100000, 'Oversized model response.', 502);
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end).trim();
        buffer = buffer.slice(end + 1);
        if (line) yield JSON.parse(line);
      }
      if (done) break;
    }
    if (buffer.trim()) yield JSON.parse(buffer);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export class OllamaModel {
  constructor({
    base = process.env.OLLAMA_URL || 'http://127.0.0.1:11434',
    name = process.env.OLLAMA_MODEL || 'qwen3:4b-instruct-2507-q4_K_M',
    context = Number(process.env.OLLAMA_CONTEXT || 8192),
    timeout = Number(process.env.OLLAMA_TIMEOUT_MS || 180000),
    thinking = process.env.OLLAMA_THINK || 'omit'
  } = {}) {
    const url = new URL(base);
    requireThat(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)
      && !url.username && !url.password, 'Only a loopback Ollama URL is allowed.');
    requireThat(!name.includes('cloud'), 'Use a downloaded local model, not a cloud model.');
    requireThat(Number.isInteger(context) && context >= 4096 && context <= 32768,
      'OLLAMA_CONTEXT must be between 4096 and 32768.');
    requireThat(Number.isInteger(timeout) && timeout >= 1000 && timeout <= 600000,
      'OLLAMA_TIMEOUT_MS must be between 1000 and 600000.');
    requireThat(['omit', 'false'].includes(thinking), 'OLLAMA_THINK must be omit or false.');
    Object.assign(this, { base: url.origin, name, context, timeout, thinking });
  }
  async health() {
    const response = await fetch(`${this.base}/api/tags`, {
      signal: AbortSignal.timeout(4000), redirect: 'error'
    });
    requireThat(response.ok, 'Ollama health check failed.', 503);
    const data = await response.json();
    const installed = data.models?.some(m => m.name === this.name || m.model === this.name);
    return { ok: Boolean(installed), model: this.name,
      error: installed ? '' : `Download the configured model: ollama pull ${this.name}` };
  }
  async chat(messages, { schema, onToken, signal } = {}) {
    const maxTokens = schema ? 1200 : 400;
    // Deliberately conservative UTF-8 byte budget, not an exact tokenizer.
    const cost = items => items.reduce((n, m) => n + Buffer.byteLength(m.content) + 32, 0);
    const budget = this.context - maxTokens - 256;
    if (!schema && messages.length > 4) {
      const prefix = messages.slice(0, 3), latest = messages.at(-1);
      const history = messages.slice(3, -1);
      while (history.length && cost([...prefix, ...history, latest]) > budget) {
        history.shift();
        if (history[0]?.role === 'assistant') history.shift();
      }
      messages = [...prefix, ...history, latest];
    }
    requireThat(cost(messages) <= budget,
      'Context budget exceeded. Shorten your sample, profile or message.');
    const started = performance.now();
    let firstTokenMs = null, result = '', final;
    const requestSignal = AbortSignal.any([
      signal || new AbortController().signal, AbortSignal.timeout(this.timeout)
    ]);
    let response;
    try {
      response = await fetch(`${this.base}/api/chat`, {
        method: 'POST', redirect: 'error', signal: requestSignal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.name, messages, stream: true, keep_alive: '10m',
          ...(schema ? { format: schema } : {}),
          ...(this.thinking === 'false' ? { think: false } : {}),
          options: { num_ctx: this.context, num_predict: maxTokens,
            temperature: schema ? 0.1 : 0.7, top_p: 0.8, top_k: 20 }
        })
      });
    } catch {
      throw new AppError(503, 'Could not reach the local model, or it timed out. Check Ollama.');
    }
    requireThat(response.ok, `Ollama returned HTTP ${response.status}. Check the model and server.`, 502);
    for await (const chunk of ndjson(response.body)) {
      requireThat(!chunk.error, 'Ollama reported a generation error. Check its logs.', 502);
      const token = chunk.message?.content || '';
      if (token) {
        if (firstTokenMs === null) firstTokenMs = Math.round(performance.now() - started);
        result += token;
        requireThat(result.length <= 12000, 'Model response exceeded the size limit.', 502);
        if (onToken) await onToken(token);
      }
      if (chunk.done) { final = chunk; break; }
    }
    requireThat(final && result.trim(), 'Model stream ended without a complete answer. Retry.', 502);
    requireThat(final.done_reason !== 'length', 'Answer reached its token limit. Ask for a shorter answer.', 502);
    return {
      text: result.trim(),
      metrics: { firstTokenMs, totalMs: Math.round(performance.now() - started),
        tokensPerSecond: final.eval_duration > 0
          ? Number((final.eval_count / (final.eval_duration / 1e9)).toFixed(1)) : null }
    };
  }
}
