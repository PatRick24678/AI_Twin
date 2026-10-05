import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import {
  AppError, requireThat, text, QUESTIONS, EXAMPLES, PROFILE_SCHEMA, ACTIONS,
  sampleInput, sourcesFor, groundedClaims, confirmedFacts, publicSession
} from './lib/domain.mjs';
import { profileMessages, twinMessages } from './lib/prompts.mjs';
import { OllamaModel } from './lib/model.mjs';

const STATIC = {
  '/': ['index.html', 'text/html'],
  '/app.js': ['app.js', 'text/javascript'],
  '/styles.css': ['styles.css', 'text/css']
};
function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}
async function body(req) {
  requireThat(req.headers['content-type']?.startsWith('application/json'), 'Send JSON.', 415);
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    requireThat(size <= 16000, 'Request is too large.', 413);
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString());
    requireThat(value && typeof value === 'object' && !Array.isArray(value), 'Send a JSON object.');
    return value;
  } catch { throw new AppError(400, 'Invalid JSON object.'); }
}
export function createApp(model = new OllamaModel()) {
  const sessions = new Map();
  const ttl = 30 * 60 * 1000;
  let modelBusy = false; // One generation at a time for a laptop demo.
  function sweep() {
    for (const [token, s] of sessions) {
      if (Date.now() - s.touched > ttl) { s.controller?.abort(); sessions.delete(token); }
    }
  }
  const timer = setInterval(sweep, 60000).unref();
  async function useModel(s, res, work) {
    requireThat(!modelBusy, 'The local model is busy. Try again shortly.', 429);
    modelBusy = true;
    const controller = new AbortController();
    s.controller = controller;
    const disconnected = () => { if (!res.writableEnded) controller.abort(); };
    res.on('close', disconnected);
    try { await work(controller.signal); }
    finally {
      res.off('close', disconnected);
      delete s.controller;
      s.touched = Date.now();
      modelBusy = false;
    }
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const port = req.socket.localPort;
      const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
      requireThat(hosts.includes(req.headers.host), 'Local access only.', 403);
      const origin = req.headers.origin;
      requireThat(!origin || hosts.some(host => origin === `http://${host}`), 'Origin not allowed.', 403);
      const path = new URL(req.url, 'http://127.0.0.1').pathname;
      const method = req.method;
      if (method === 'GET' && STATIC[path]) {
        const [file, type] = STATIC[path];
        const data = await readFile(new URL(`./public/${file}`, import.meta.url));
        res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` });
        return res.end(data);
      }
      if (method === 'GET' && path === '/api/info') {
        return json(res, 200, { examples: EXAMPLES, model: model.name });
      }
      if (method === 'GET' && path === '/api/health') {
        let result;
        try { result = await model.health(); }
        catch { result = { ok: false, error: 'Start Ollama and check the configured local model.' }; }
        return json(res, result.ok ? 200 : 503, result);
      }
      requireThat(path.startsWith('/api/'), 'Not found.', 404);
      if (method !== 'GET') requireThat(req.headers['x-future-self'] === '1', 'Missing client header.', 403);
      sweep();
      if (method === 'POST' && path === '/api/session') {
        const input = await body(req);
        requireThat(input.consent === true, 'Confirm the prototype notice first.');
        requireThat(sessions.size < 20, 'Too many sessions. Reset an old one or restart the server.', 429);
        const token = randomBytes(32).toString('base64url');
        const s = {
          name: text(input.name, 'Name or alias', 50, 1), stage: 'intake',
          answers: [], intake: [{ role: 'assistant', content: QUESTIONS[0] }],
          sample: null, claims: [], facts: [], messages: [], reflection: '',
          metrics: null, notice: '', touched: Date.now()
        };
        sessions.set(token, s);
        return json(res, 201, { token, session: publicSession(s) });
      }
      const token = (req.headers.authorization || '').replace(/^Bearer /, '');
      const s = sessions.get(token);
      requireThat(s, 'Session missing or expired. Start a new one.', 401);
      s.touched = Date.now();
      if (method === 'DELETE' && path === '/api/session') {
        s.controller?.abort(); sessions.delete(token);
        return json(res, 200, { ok: true });
      }
      if (method === 'GET' && path === '/api/session') return json(res, 200, publicSession(s));
      requireThat(method === 'POST', 'Not found.', 404);
      const input = await body(req);
      requireThat(sessions.get(token) === s, 'Session was reset. Start again.', 401);
      requireThat(!s.controller, 'A response is already being generated.', 409);
      if (path === '/api/answer') {
        requireThat(s.stage === 'intake', 'The intake is already complete.', 409);
        const answer = text(input.text, 'Answer', 600, 1);
        s.answers.push(answer);
        s.intake.push({ role: 'user', content: answer });
        if (s.answers.length === QUESTIONS.length) s.stage = 'sample';
        else s.intake.push({ role: 'assistant', content: QUESTIONS[s.answers.length] });
        return json(res, 200, publicSession(s));
      }
      if (path === '/api/sample') {
        requireThat(s.stage === 'sample', 'Complete the intake first.', 409);
        const sample = sampleInput(input);
        return await useModel(s, res, async signal => {
          s.sample = sample;
          const output = await model.chat(profileMessages(s), { schema: PROFILE_SCHEMA, signal });
          signal.throwIfAborted();
          let parsed;
          try { parsed = JSON.parse(output.text); }
          catch { throw new AppError(502, 'The model produced invalid JSON. Retry or enter a manual profile.'); }
          const claims = groundedClaims(parsed, sourcesFor(s));
          requireThat(claims.length >= 2, 'Too few source-backed observations. Retry or enter a manual profile.', 502);
          s.claims = claims; s.metrics = output.metrics; s.stage = 'review';
          s.notice = 'Check the interpretation. A matching quote does not prove that the interpretation is correct.';
          json(res, 200, publicSession(s));
        });
      }
      if (path === '/api/profile') {
        requireThat(['sample', 'review', 'twin'].includes(s.stage), 'Complete the intake first.', 409);
        const facts = confirmedFacts(input);
        const sample = s.stage === 'sample' && input.sample ? sampleInput(input.sample) : s.sample;
        s.facts = facts; s.sample = sample;
        // Explicit correction resets the scene so discarded claims cannot persist in old dialogue.
        s.messages = []; s.stage = 'twin'; s.metrics = null; s.notice = '';
        return json(res, 200, publicSession(s));
      }
      if (path === '/api/twin') {
        requireThat(s.stage === 'twin', 'Confirm your profile first.', 409);
        const action = input.action;
        requireThat(typeof action === 'string' && (action === 'say' || Object.hasOwn(ACTIONS, action)), 'Unknown action.');
        requireThat((action === 'open') === (s.messages.length === 0), 'Open the scene once, then continue the conversation.', 409);
        requireThat(s.messages.filter(m => m.role === 'user').length < 8,
          'This demo is limited to eight exchanges. Finish or edit your profile to restart.', 409);
        const userText = action === 'say' ? text(input.text, 'Message', 600, 1) : ACTIONS[action];
        return await useModel(s, res, async signal => {
          res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8' });
          res.flushHeaders();
          const emit = async event => {
            signal.throwIfAborted();
            if (!res.write(JSON.stringify(event) + '\n')) await once(res, 'drain', { signal });
          };
          try {
            const output = await model.chat(twinMessages(s, action, userText), {
              signal, onToken: value => emit({ type: 'token', text: value })
            });
            signal.throwIfAborted();
            // Commit only a completed exchange, never an interrupted half-answer.
            if (action !== 'open') {
              s.messages.push({
                role: 'user',
                content: userText,
                source: action === 'say' ? 'typed' : 'suggestion'
              });
            }
            s.messages.push({ role: 'assistant', content: output.text });
            s.metrics = output.metrics;
            await emit({ type: 'done', session: publicSession(s) });
          } catch (error) {
            if (!signal.aborted && !res.destroyed) await emit({
              type: 'error', error: error instanceof AppError ? error.message : 'Generation was interrupted. Retry.'
            });
          } finally { res.end(); }
        });
      }
      if (path === '/api/finish') {
        requireThat(s.stage === 'twin' && s.messages.length > 0, 'Meet your future self first.', 409);
        s.reflection = text(input.reflection, 'Reflection', 1000);
        s.stage = 'done';
        return json(res, 200, publicSession(s));
      }
      throw new AppError(404, 'Not found.');
    } catch (error) {
      if (!res.headersSent && !res.destroyed) json(res,
        error instanceof AppError ? error.status : 500,
        { error: error instanceof AppError ? error.message : 'Request failed. Check that the local services are running.' });
      else if (!res.writableEnded) res.end();
    }
  });
  server.requestTimeout = 15000;
  server.on('close', () => {
    clearInterval(timer);
    for (const s of sessions.values()) s.controller?.abort();
    sessions.clear();
  });
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 3000);
  requireThat(Number.isInteger(port) && port >= 1024 && port <= 65535, 'Invalid PORT.');
  const server = createApp();
  server.listen(port, '127.0.0.1', () => console.log(`Future Self: http://127.0.0.1:${port}`));
  server.on('error', error => { console.error(error.message); process.exitCode = 1; });
}
