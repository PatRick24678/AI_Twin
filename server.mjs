import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import {
  AppError, requireThat, text, EXAMPLES, ACTIONS, sampleInput, publicSession
} from './lib/domain.mjs';
import { twinMessages } from './lib/prompts.mjs';
import {
  PROFILE_TOPICS, PROFILE_LIMITS, createProfileDraft, answerProfileQuestion, confirmProfile, useProfileNotes
} from './lib/profile-core.mjs';
import { advanceProfile, canRetryProfile } from './lib/profile-builder.mjs';
import { AnthropicModel } from './lib/anthropic-model.mjs';
import { generateSuggestions } from './lib/suggestions.mjs';
import { createInterview, recordInterviewInput } from './lib/interview-state.mjs';
import { InterviewError, INTERVIEW_LIMITS } from './lib/interview-contract.mjs';
import {
  INTERVIEW_BUDGET, newInterviewUsage, advanceInterview, canRetryInterview,
  recordControlledAnswer, explicitInterviewControl, endAfterProcessingLimit
} from './lib/interviewer.mjs';

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
    requireThat(size <= 64000, 'Request is too large.', 413);
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString());
    requireThat(value && typeof value === 'object' && !Array.isArray(value), 'Send a JSON object.');
    return value;
  } catch { throw new AppError(400, 'Invalid JSON object.'); }
}
export function createApp(model = new AnthropicModel()) {
  const sessions = new Map();
  const ttl = 30 * 60 * 1000;
  let modelBusy = false; // Keep one generation at a time for this private development prototype.
  function sweep() {
    for (const [token, s] of sessions) {
      if (Date.now() - s.touched > ttl) { s.controller?.abort(); sessions.delete(token); }
    }
  }
  const timer = setInterval(sweep, 60000).unref();
  async function useModel(s, res, work) {
    requireThat(!modelBusy, 'Another AI request is running. Try again shortly.', 429);
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
  function syncInterview(s) {
    s.answers = s.interview.messages
      .filter(message => message.role === 'user' && message.kind === 'answer')
      .map(message => message.text);
    s.intake = s.interview.messages.map(message => ({
      role: message.role,
      content: message.kind === 'skip'
        ? message.displayText || 'Skipped this question.' : message.text
    }));
    s.interviewRetryAllowed = canRetryInterview(s.interview, s.interviewUsage);
  }
  async function interviewResponse(s, res, signal) {
    const pending = s.interview;
    try {
      const result = await advanceInterview(model, pending, s.interviewUsage, signal);
      signal.throwIfAborted();
      requireThat(s.interview === pending, 'The interview changed while preparing this response.', 409);
      s.interview = result.state;
      s.metrics = result.metrics;
      syncInterview(s);
      json(res, 200, publicSession(s));
    } catch (error) {
      if (res.destroyed) return;
      if (signal.aborted) {
        if (!res.writableEnded) json(res, 409, { error: 'The interview request was cancelled.' });
        return;
      }
      // Validator rule text only, so a failed turn can be diagnosed from the terminal.
      if (error.reasons?.length) console.warn(`Interview turn rejected: ${error.reasons.join(' | ')}`);
      // An accepted answer/skip is retained on failure. Retry generation, not input.
      if (error.status === 413 || !canRetryInterview(s.interview, s.interviewUsage)) {
        s.interview = endAfterProcessingLimit(s.interview,
          error.status === 413 ? 'context_limit' : 'processing_limit');
      }
      syncInterview(s);
      json(res, error instanceof AppError ? error.status : 502, {
        error: error instanceof AppError ? error.message :
          'Could not prepare the next interview turn. Your answer is kept; retry the response.',
        session: publicSession(s)
      });
    }
  }
  function syncProfile(s) {
    s.stage = s.profileDraft.status === 'review' ? 'review'
      : s.profileDraft.status === 'clarifying' ? 'clarify' : 'profile_build';
    s.profileRetryAllowed = canRetryProfile(s.profileDraft);
    s.notice = s.profileDraft.note;
  }
  async function profileResponse(s, res, signal) {
    const pending = s.profileDraft, requestId = pending.requestId;
    try {
      const result = await advanceProfile(model, pending, signal);
      signal.throwIfAborted();
      requireThat(s.profileDraft === pending && pending.requestId === requestId,
        'The profile changed while processing this response.', 409);
      s.profileDraft = result.draft; s.metrics = result.metrics;
      syncProfile(s); json(res, 200, publicSession(s));
    } catch (error) {
      if (res.destroyed) return;
      if (signal.aborted) {
        if (!res.writableEnded) json(res, 409, { error: 'The profile request was cancelled.' });
        return;
      }
      syncProfile(s);
      if (error.status === 413) s.profileRetryAllowed = false;
      json(res, error instanceof AppError ? error.status : 502, {
        error: error instanceof AppError ? error.message : 'Could not process the profile. Your input is kept.',
        session: publicSession(s)
      });
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
        return json(res, 200, { examples: EXAMPLES, model: model.name, profileTopics: PROFILE_TOPICS, profileLimits: PROFILE_LIMITS });
      }
      if (method === 'GET' && path === '/api/health') {
        let result;
        try { result = await model.health(); }
        catch { result = { ok: false, error: 'Could not check Claude access. Check the key, model and connection.' }; }
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
          answers: [], intake: [], interview: createInterview(),
          interviewUsage: newInterviewUsage(), interviewRetryAllowed: true,
          sample: null, claims: [], facts: [], profile: null, profileDraft: null, profileRetryAllowed: false, messages: [], reflection: '',
          profileVersion: 0, suggestions: [], suggestionStatus: 'pending',
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
      if (path === '/api/interview/next') {
        requireThat(s.stage === 'intake' && s.interview.status === 'thinking',
          'There is no interview response waiting to be generated.', 409);
        requireThat(input.requestId === s.interview.requestId,
          'This interview request is out of date. Refresh the session state.', 409);
        return await useModel(s, res, signal => interviewResponse(s, res, signal));
      }
      if (path === '/api/answer') {
        requireThat(s.stage === 'intake' && s.interview.status === 'waiting',
          'Wait for the question, retry a pending response, or finish the completed interview.', 409);
        requireThat(typeof input.questionId === 'string' && input.questionId === s.interview.activeQuestion.id,
          'This answer belongs to an old or different question.', 409);
        const kind = input.kind || 'answer';
        requireThat(['answer', 'skip'].includes(kind), 'Choose answer or skip.');
        const answer = kind === 'answer'
          ? text(input.text, 'Answer', INTERVIEW_LIMITS.answerCharacters, 1) : '';
        requireThat(kind !== 'skip' || !input.text, 'A skip must not contain answer text.');
        const control = kind === 'answer' ? explicitInterviewControl(answer) : 'skip';
        if (!control) {
          const used = s.answers.reduce((n, value) => n + value.length, 0);
          requireThat(used + answer.length <= INTERVIEW_BUDGET.answerCharactersTotal,
            'This interview has reached its text allowance. Shorten this answer, skip, or type "stop".');
        }
        if (control === 'stop') {
          s.interview = recordControlledAnswer(s.interview, answer);
          syncInterview(s);
          return json(res, 200, publicSession(s));
        }
        return await useModel(s, res, async signal => {
          s.interview = kind === 'skip'
            ? recordInterviewInput(s.interview, { kind: 'skip' })
            : recordControlledAnswer(s.interview, answer);
          syncInterview(s);
          await interviewResponse(s, res, signal);
        });
      }
      if (path === '/api/interview/continue') {
        requireThat(s.stage === 'intake' && s.interview.status === 'complete',
          'The interview has not finished yet.', 409);
        s.stage = 'sample';
        return json(res, 200, publicSession(s));
      }
      if (path === '/api/sample') {
        requireThat(s.stage === 'sample', 'Complete the interview before preparing a profile.', 409);
        const sample = sampleInput(input), mode = input.mode || 'build';
        requireThat(['build', 'manual'].includes(mode), 'Choose build or manual profile.');
        const draft = createProfileDraft(s, sample, mode);
        const save = () => { s.sample = sample; s.profileDraft = draft; syncProfile(s); };
        if (draft.status === 'review') { save(); return json(res, 200, publicSession(s)); }
        return await useModel(s, res, async signal => {
          save(); await profileResponse(s, res, signal);
        });
      }
      if (path === '/api/profile/retry') {
        requireThat(s.stage === 'profile_build' && s.profileDraft?.id === input.draftId &&
          input.requestId === s.profileDraft.requestId, 'This pending profile request is out of date.', 409);
        requireThat(s.profileRetryAllowed, 'Retry limit reached. Continue with the available notes.', 429);
        return await useModel(s, res, signal => profileResponse(s, res, signal));
      }
      if (path === '/api/profile/notes') {
        requireThat(['profile_build', 'clarify'].includes(s.stage) && s.profileDraft?.id === input.draftId,
          'There is no unfinished profile with that ID.', 409);
        s.profileDraft = useProfileNotes(s.profileDraft); syncProfile(s);
        return json(res, 200, publicSession(s));
      }
      if (path === '/api/profile/clarify') {
        requireThat(s.stage === 'clarify' && s.profileDraft?.id === input.draftId,
          'This clarification is not part of the current profile.', 409);
        const kind = input.kind || 'answer';
        requireThat(['answer', 'skip'].includes(kind), 'Choose answer or skip.');
        const value = kind === 'answer' ? text(input.text, 'Answer', PROFILE_LIMITS.answer, 1) : '';
        requireThat(kind !== 'skip' || !input.text, 'A skip must not include an answer.');
        const control = kind === 'skip' ? 'skip' : explicitInterviewControl(value);
        const draft = answerProfileQuestion(s.profileDraft, {
          questionId: input.questionId, kind: control || 'answer', text: control ? '' : value
        });
        if (draft.status !== 'resolving') {
          s.profileDraft = draft; syncProfile(s); return json(res, 200, publicSession(s));
        }
        return await useModel(s, res, async signal => {
          s.profileDraft = draft; syncProfile(s); await profileResponse(s, res, signal);
        });
      }
      if (path === '/api/profile') {
        requireThat(['review', 'prepare', 'twin'].includes(s.stage), 'Finish the profile draft first.', 409);
        const profile = confirmProfile(s, input);
        s.profile = profile; s.profileVersion = profile.version;
        s.facts = profile.entries.map(item => item.text); // Read-only compatibility/display projection.
        s.messages = []; s.stage = 'prepare'; s.metrics = null; s.notice = '';
        s.suggestions = []; s.suggestionStatus = 'pending';
        return json(res, 200, publicSession(s));
      }
      if (path === '/api/suggestions') {
        requireThat(['prepare', 'twin'].includes(s.stage), 'Confirm your profile first.', 409);
        requireThat(input.profileVersion === s.profileVersion, 'Your profile changed. Use the current profile.', 409);
        requireThat(['generate', 'skip'].includes(input.mode), 'Choose generate or skip.');
        // A completed set (or explicit skip) is fixed for this profile version.
        if (s.stage === 'twin') return json(res, 200, publicSession(s));
        if (input.mode === 'skip') {
          s.suggestions = []; s.suggestionStatus = 'skipped'; s.stage = 'twin';
          return json(res, 200, publicSession(s));
        }
        return await useModel(s, res, async signal => {
          const suggestions = await generateSuggestions(model, s, signal);
          signal.throwIfAborted();
          s.suggestions = suggestions; s.suggestionStatus = 'ready'; s.stage = 'twin';
          json(res, 200, publicSession(s));
        });
      }
      if (path === '/api/twin') {
        requireThat(s.stage === 'twin', 'Confirm your profile, then prepare or explicitly skip the buttons.', 409);
        const action = input.action;
        requireThat(typeof action === 'string' && (['say', 'suggestion'].includes(action) || Object.hasOwn(ACTIONS, action)), 'Unknown action.');
        requireThat((action === 'open') === (s.messages.length === 0), 'Open the scene once, then continue the conversation.', 409);
        requireThat(s.messages.filter(m => m.role === 'user').length < 8,
          'This demo is limited to eight exchanges. Finish or edit your profile to restart.', 409);
        let selected;
        if (action === 'suggestion') {
          selected = s.suggestions.find(item => item.id === input.suggestionId);
          requireThat(selected, 'This button is not available for your current profile.', 400);
        }
        // Use the server-stored request, never a prompt supplied with a button click.
        const userText = selected ? selected.request
          : action === 'say' ? text(input.text, 'Message', 600, 1) : ACTIONS[action];
        return await useModel(s, res, async signal => {
          res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8' });
          res.flushHeaders();
          const emit = async event => {
            signal.throwIfAborted();
            if (!res.write(JSON.stringify(event) + '\n')) await once(res, 'drain', { signal });
          };
          try {
            const output = await model.chat(twinMessages(s, action, userText, { includeSample: action === 'demo' || selected?.kind === 'draft' }), {
              signal, onToken: value => emit({ type: 'token', text: value })
            });
            signal.throwIfAborted();
            // Commit only a completed exchange, never an interrupted half-answer.
            if (action !== 'open') {
              s.messages.push({
                role: 'user',
                content: selected ? selected.label : userText,
                source: action === 'say' ? 'typed' : 'suggestion',
                ...(selected ? { request: selected.request } : {})
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
        error instanceof AppError ? error.status : error instanceof InterviewError ? 400 : 500,
        { error: error instanceof AppError || error instanceof InterviewError ? error.message : 'Request failed. Check the application setup and connection.' });
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
