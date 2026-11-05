import http from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import {
  AppError, requireThat, text, EXAMPLES, ACTIONS, sampleInput, publicSession
} from './lib/domain.mjs';
import { twinMessages, problemMessages, PROBLEM_EXCHANGES } from './lib/prompts.mjs';
import {
  PROFILE_TOPICS, PROFILE_LIMITS, createProfileDraft, answerProfileQuestion, confirmProfile, useProfileNotes
} from './lib/profile-core.mjs';
import { advanceProfile, canRetryProfile } from './lib/profile-builder.mjs';
import { AnthropicModel } from './lib/anthropic-model.mjs';
import { createSpeech, SPEECH_LIMITS, AUDIO_TYPES } from './lib/speech-model.mjs';
import { createPortraits, locateFace, PORTRAIT_LIMITS, DEFAULT_FACE_POINTS } from './lib/portrait-model.mjs';
import { generateSuggestions } from './lib/suggestions.mjs';
import { createCryptoBox } from './lib/crypto-box.mjs';
import { openStore, RETENTION } from './lib/store.mjs';
import { wordCount } from './lib/reply-style.mjs';
import {
  AUTH, checkEmail, checkPassword, hashPassword, verifyPassword, newSessionId, hashToken, readCookie, sessionCookie, createThrottle,
  newResetCode, sameCode
} from './lib/auth.mjs';
import { createInterview, recordInterviewInput } from './lib/interview-state.mjs';
import { InterviewError, INTERVIEW_LIMITS } from './lib/interview-contract.mjs';
import {
  INTERVIEW_BUDGET, newInterviewUsage, advanceInterview, canRetryInterview,
  recordControlledAnswer, explicitInterviewControl, endAfterProcessingLimit
} from './lib/interviewer.mjs';

// Files the page may load. Paths are relative to public/; Tommy's picture lives in the top-level assets/ folder.
const STATIC = {
  '/': ['index.html', 'text/html'],
  '/app.js': ['app.js', 'text/javascript'],
  '/voice-activity.js': ['voice-activity.js', 'text/javascript'],
  '/live-transcript.js': ['live-transcript.js', 'text/javascript'],
  '/pcm-worklet.js': ['pcm-worklet.js', 'text/javascript'],
  '/talking-portrait.js': ['talking-portrait.js', 'text/javascript'],
  '/tommy.js': ['tommy.js', 'text/javascript'],
  '/assets/tommy.png': ['../assets/tommy.png', 'image/png'],
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
// Raw audio for transcription only: bounded, held in memory for one request, never stored or logged.
async function audioBody(req) {
  const type = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  requireThat(Object.hasOwn(AUDIO_TYPES, type), 'Send a supported audio recording.', 415);
  const tooLarge = 'The recording is too large. Record a shorter answer.';
  requireThat(Number(req.headers['content-length'] || 0) <= SPEECH_LIMITS.audioBytes, tooLarge, 413);
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    requireThat(size <= SPEECH_LIMITS.audioBytes, tooLarge, 413);
    chunks.push(chunk);
  }
  return { type, audio: Buffer.concat(chunks) };
}
// Speaking is offered where the participant answers: a waiting interview question, a profile clarification
// or the conversation.
const VOICE_STAGE = 'Voice input is available while a question is waiting or in the conversation.';
const voiceAllowed = s => (s.stage === 'intake' && s.interview.status === 'waiting') ||
  (s.stage === 'clarify' && s.profileDraft?.status === 'clarifying') || s.stage === 'twin';
// Saved accounts are optional: without DATA_ENCRYPTION_KEY the app runs guest-only, as before.
export function createStore() {
  if (!process.env.DATA_ENCRYPTION_KEY) return null;
  try { return openStore({ box: createCryptoBox() }); }
  catch (error) { console.warn(`[storage] ${error.message} Saved accounts are disabled.`); return null; }
}
// What is saved for an account: the working state, minus what must never be stored.
const SAVED = ['name', 'stage', 'answers', 'intake', 'interview', 'interviewUsage', 'interviewRetryAllowed', 'sample', 'claims',
  'facts', 'profile', 'profileDraft', 'profileRetryAllowed', 'messages', 'problemThreads', 'reflection', 'profileVersion',
  'suggestions', 'suggestionStatus', 'transcriptions', 'notice', 'portrait', 'portraitCount', 'portraitSafetyId'];
export function savedDocument(s) {
  const document = structuredClone(Object.fromEntries(SAVED.map(key => [key, s[key]])));
  // Pasted work samples may be confidential company material: they stay in memory for this visit only.
  if (document.sample) document.sample.text = '';
  if (document.profileDraft?.sample) document.profileDraft.sample.text = '';
  if (document.profile) {
    // Once the profile is confirmed, the raw interview is no longer needed: keep the profile (with its short
    // evidence quotes), the open-question list and the answer word counts for reply pacing, not the answers.
    document.answerWordCounts = s.answerWordCounts || (s.answers || []).map(wordCount);
    document.answers = []; document.intake = [];
    const { interview, profileDraft } = document;
    if (interview) Object.assign(interview, { messages: [], questions: [], observations: [], problems: [], problemDiscards: [],
      activeQuestion: null, pendingInput: null, topics: Object.fromEntries(Object.entries(interview.topics || {})
        .map(([id, topic]) => [id, { ...topic, boundaryEvidence: null }])) });
    if (profileDraft) Object.assign(profileDraft, { entries: [], problems: [], retired: [], pendingAnswer: null,
      questions: profileDraft.questions.map(({ id, topic, question, status, relatedIds }) => ({ id, topic, question, status, relatedIds })) });
  }
  return document;
}
const DAY = 24 * 60 * 60 * 1000;

export function createApp(model = new AnthropicModel(), speech = createSpeech(), store = createStore(), portraits = createPortraits()) {
  const sessions = new Map();
  const accounts = new Map(); // Account ID → working token: one working copy per account in memory.
  const throttle = createThrottle();
  const ttl = 30 * 60 * 1000;
  let modelBusy = false; // Keep one generation at a time for this private development prototype.
  let lockedForFace = false; // The lock is held by the short look at a new face picture.
  // Waits until the Claude lock is free (true), or gives up after `ms` (false).
  async function lockFree(ms, signal) {
    const until = Date.now() + ms;
    while (modelBusy) {
      if (Date.now() > until) return false;
      await new Promise(resolve => setTimeout(resolve, 300));
      signal?.throwIfAborted();
    }
    return true;
  }
  function sweep() {
    for (const [token, s] of sessions) {
      if (Date.now() - s.touched > ttl) {
        s.controller?.abort(); s.speechController?.abort(); s.portraitController?.abort(); sessions.delete(token);
        if (s.userId) accounts.delete(s.userId); // Already saved after each change; this only frees memory.
      }
    }
  }
  const timer = setInterval(sweep, 60000).unref();
  // Storage limitation, at start-up and daily: inactive accounts, expired logins, old audit entries, and
  // interviews left unfinished for 30 days (the account stays; its twin starts again).
  function purge() {
    store.purge();
    for (const userId of store.staleTwins(RETENTION.unfinishedDays)) {
      if (accounts.has(userId)) continue;
      try { if (!store.loadTwin(userId)?.profile) { store.deleteTwin(userId); store.audit(null, 'unfinished_twin_deleted', userId); } }
      catch { store.deleteTwin(userId); } // Unreadable (e.g. a lost key): nothing recoverable to keep.
    }
  }
  if (store) purge();
  const purgeTimer = store ? setInterval(purge, DAY).unref() : null;
  function workspace(name, userId = null) {
    return {
      name, userId, stage: 'intake', answers: [], intake: [], interview: createInterview(),
      interviewUsage: newInterviewUsage(), interviewRetryAllowed: true,
      sample: null, claims: [], facts: [], profile: null, profileDraft: null, profileRetryAllowed: false, messages: [], problemThreads: {}, reflection: '',
      profileVersion: 0, suggestions: [], suggestionStatus: 'pending', transcriptions: 0,
      metrics: null, notice: '', touched: Date.now(),
      // The face: drawn on request, at most PORTRAIT_LIMITS.perTwin times. The safety ID is random, never a name.
      portrait: null, portraitCount: 0, portraitSafetyId: randomUUID()
    };
  }
  function persist(s) {
    if (!s.userId || !store) return;
    try { store.saveTwin(s.userId, savedDocument(s)); }
    catch (error) { console.error(`[storage] Could not save a twin: ${error.message}`); }
  }
  // The account's working copy: the one in memory, else the saved twin, else a new one.
  function openWorkspace(user, name = '') {
    const existing = accounts.get(user.id);
    if (existing && sessions.has(existing)) return existing;
    requireThat(sessions.size < 20, 'Too many sessions. Reset an old one or restart the server.', 429);
    const saved = store.loadTwin(user.id);
    const s = saved ? { ...workspace(saved.name, user.id), ...saved, userId: user.id, touched: Date.now() }
      : workspace(name || user.email.split('@')[0], user.id);
    const token = randomBytes(32).toString('base64url');
    sessions.set(token, s); accounts.set(user.id, token);
    if (!saved) persist(s);
    return token;
  }
  function signIn(res, user) {
    const id = newSessionId();
    store.createSession({ idHash: hashToken(id), userId: user.id, expiresAt: Date.now() + AUTH.absoluteMs });
    store.touchUser(user.id);
    res.setHeader('Set-Cookie', sessionCookie(id));
  }
  // The signed-in account for this request, or null. Expired or idle logins are removed.
  function currentUser(req) {
    const id = readCookie(req.headers.cookie);
    if (!store || !id) return null;
    const idHash = hashToken(id), record = store.findSession(idHash), now = Date.now();
    if (!record) return null;
    if (now > record.expiresAt || now - record.lastSeenAt > AUTH.idleMs) { store.deleteSession(idHash); return null; }
    store.touchSession(idHash); store.touchUser(record.userId);
    return store.findUser(record.userId) || null;
  }
  // Admins manage accounts and have no twin of their own, so they get no working copy.
  const signedIn = (user, token = user.role === 'admin' ? '' : openWorkspace(user)) =>
    ({ user: { email: user.email, role: user.role }, token, session: token ? publicSession(sessions.get(token)) : null });
  function dropWorkspace(token) {
    const s = sessions.get(token);
    if (!s) return;
    persist(s); s.controller?.abort(); s.speechController?.abort(); s.portraitController?.abort(); sessions.delete(token);
    if (s.userId) accounts.delete(s.userId);
  }
  async function useModel(s, res, work) {
    // A face being located takes a few seconds: an interview turn waits for it instead of failing.
    if (modelBusy && lockedForFace) await lockFree(15000);
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
      const result = await advanceInterview(model, pending, s.interviewUsage, signal, { voice: s.voiceMode });
      signal.throwIfAborted();
      requireThat(s.interview === pending, 'The interview changed while preparing this response.', 409);
      s.interview = result.state;
      s.metrics = result.metrics;
      // Rule text only: frequent discards mean the problem prompt needs tuning.
      if (result.state.problemDiscards?.length) console.warn(`Problem updates discarded: ${result.state.problemDiscards.join(' | ')}`);
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
      // Rule text only: parts of the model's reading that were not applied.
      if (result.draft.ignored?.length) console.warn(`Profile answer parts set aside: ${result.draft.ignored.join(' | ')}`);
      syncProfile(s); json(res, 200, publicSession(s));
    } catch (error) {
      if (res.destroyed) return;
      if (signal.aborted) {
        if (!res.writableEnded) json(res, 409, { error: 'The profile request was cancelled.' });
        return;
      }
      if (error.reasons?.length) console.warn(`Profile response rejected: ${error.reasons.join(' | ')}`);
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
      // Live transcription streams from the browser straight to Mistral; nothing else leaves the page.
      `default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'${speech?.live ? ' wss://api.mistral.ai' : ''}; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`);
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
        res.writeHead(200, { 'Content-Type': type.startsWith('image/') ? type : `${type}; charset=utf-8` });
        return res.end(data);
      }
      if (method === 'GET' && path === '/api/info') {
        return json(res, 200, { examples: EXAMPLES, model: model.name, profileTopics: PROFILE_TOPICS, profileLimits: PROFILE_LIMITS,
          voice: { available: Boolean(speech), live: Boolean(speech?.live), maxSeconds: SPEECH_LIMITS.seconds },
          portraits: { available: Boolean(portraits), descriptionLength: PORTRAIT_LIMITS.description, perTwin: PORTRAIT_LIMITS.perTwin },
          accounts: Boolean(store) });
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
        // A guest: kept in memory only, never written to the database.
        const token = randomBytes(32).toString('base64url'), s = workspace(text(input.name, 'Name or alias', 50, 1));
        sessions.set(token, s);
        return json(res, 201, { token, session: publicSession(s) });
      }
      if (path.startsWith('/api/auth/')) {
        requireThat(store, 'Saved accounts are not set up on this server. Use "Try without saving".', 503);
        if (method === 'GET' && path === '/api/auth/me') {
          const user = currentUser(req);
          return json(res, 200, user ? signedIn(user) : { user: null });
        }
        requireThat(method === 'POST', 'Not found.', 404);
        const input = await body(req), address = `ip:${req.socket.remoteAddress || 'local'}`;
        if (path === '/api/auth/signup') {
          requireThat(input.consent === true, 'Confirm the privacy notice first.');
          const email = checkEmail(input.email), name = text(input.name, 'Name or alias', 50, 1);
          checkPassword(input.password, email);
          throttle.check(`${address}:signup`);
          const user = store.createUser({ email, passwordHash: await hashPassword(input.password), consentVersion: AUTH.consentVersion });
          if (!user) {
            throttle.fail(`${address}:signup`);
            throw new AppError(409, 'Could not create an account with these details. If you already have one, log in instead.');
          }
          signIn(res, user);
          return json(res, 201, signedIn(user, openWorkspace(user, name)));
        }
        // A one-time code from an admin replaces a forgotten password (no email service in the local phase).
        if (path === '/api/auth/reset') {
          const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
          throttle.check(`email:${email}`);
          const user = email ? store.findUserByEmail(email) : null;
          const valid = Boolean(user?.resetHash) && user.resetExpires > Date.now() && sameCode(input.code, user.resetHash);
          if (!valid) { throttle.fail(`email:${email}`); throw new AppError(401, 'That email and code do not match a valid reset code.'); }
          checkPassword(input.password, email);
          store.setPassword(user.id, await hashPassword(input.password)); // Also ends every existing login.
          dropWorkspace(accounts.get(user.id));
          store.audit(user.id, 'password_reset', user.id);
          throttle.succeed(`email:${email}`);
          signIn(res, user);
          return json(res, 200, signedIn(user));
        }
        if (path === '/api/auth/login') {
          const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
          throttle.check(`email:${email}`);
          const user = email ? store.findUserByEmail(email) : null;
          // Same message and similar timing whether the email is unknown or the password is wrong.
          const valid = await verifyPassword(input.password, user?.passwordHash);
          if (!user || !valid) { throttle.fail(`email:${email}`); throw new AppError(401, 'Email or password is incorrect.'); }
          throttle.succeed(`email:${email}`);
          signIn(res, user);
          return json(res, 200, signedIn(user));
        }
        if (path === '/api/auth/logout') {
          const id = readCookie(req.headers.cookie), record = id && store.findSession(hashToken(id));
          if (record) { store.deleteSession(hashToken(id)); dropWorkspace(accounts.get(record.userId)); }
          res.setHeader('Set-Cookie', sessionCookie('', { clear: true }));
          return json(res, 200, { ok: true });
        }
        throw new AppError(404, 'Not found.');
      }
      if (path.startsWith('/api/account')) {
        requireThat(store, 'Saved accounts are not set up on this server.', 503);
        const user = currentUser(req);
        requireThat(user, 'Log in first.', 401);
        // Right of access: the account details and everything saved for the twin, as JSON.
        if (method === 'GET' && path === '/api/account/export') {
          const token = accounts.get(user.id), live = token && sessions.get(token);
          store.audit(user.id, 'data_exported', user.id);
          return json(res, 200, { exportedAt: new Date().toISOString(), label: 'Your saved Future Self data (AI-generated simulation, not a prediction)',
            account: { email: user.email, createdAt: new Date(user.createdAt).toISOString(), consentVersion: user.consentVersion },
            twin: live ? savedDocument(live) : store.loadTwin(user.id) });
        }
        // Right to erasure: confirmed with the password, then the account, logins and twin are deleted together.
        if (method === 'POST' && path === '/api/account/delete') {
          const input = await body(req);
          throttle.check(`email:${user.email}`);
          if (!await verifyPassword(input.password, user.passwordHash)) {
            throttle.fail(`email:${user.email}`);
            throw new AppError(403, 'That password is not correct.');
          }
          const token = accounts.get(user.id);
          if (token) { const s = sessions.get(token); s?.controller?.abort(); s?.speechController?.abort(); s?.portraitController?.abort(); sessions.delete(token); accounts.delete(user.id); }
          store.deleteUser(user.id);
          res.setHeader('Set-Cookie', sessionCookie('', { clear: true }));
          return json(res, 200, { ok: true });
        }
        throw new AppError(404, 'Not found.');
      }
      // Account management for Tatoma admins: metadata only, never profiles, interviews or conversations.
      if (path.startsWith('/api/admin/')) {
        requireThat(store, 'Saved accounts are not set up on this server.', 503);
        const admin = currentUser(req);
        requireThat(admin?.role === 'admin', 'Admins only.', 403);
        if (method === 'GET' && path === '/api/admin/accounts') {
          return json(res, 200, { accounts: store.listUsers(), audit: store.listAudit().slice(-50).reverse() });
        }
        requireThat(method === 'POST', 'Not found.', 404);
        const input = await body(req), target = typeof input.userId === 'string' ? store.findUser(input.userId) : null;
        requireThat(target, 'That account no longer exists.', 404);
        requireThat(target.id !== admin.id, 'Use another admin account to change your own.', 409);
        if (path === '/api/admin/accounts/delete') {
          dropWorkspace(accounts.get(target.id));
          store.deleteUser(target.id, admin.id);
          return json(res, 200, { ok: true });
        }
        if (path === '/api/admin/accounts/reset') {
          // Shown once to the admin, who hands it over in person; only its hash is stored.
          const code = newResetCode(), expires = Date.now() + 30 * 60 * 1000;
          store.setResetCode(target.id, hashToken(code), expires);
          store.audit(admin.id, 'reset_code_issued', target.id);
          return json(res, 200, { code, expiresAt: new Date(expires).toISOString() });
        }
        throw new AppError(404, 'Not found.');
      }
      const token = (req.headers.authorization || '').replace(/^Bearer /, '');
      const s = sessions.get(token);
      requireThat(s, 'Session missing or expired. Start a new one.', 401);
      // A saved twin answers only to its own login, not to the working token alone.
      if (s.userId) requireThat(currentUser(req)?.id === s.userId, 'Your login has expired. Log in again.', 401);
      s.touched = Date.now();
      // Saved after every change, once the response (including a streamed reply) is complete.
      if (s.userId && method === 'POST') res.once('finish', () => persist(s));
      if (method === 'DELETE' && path === '/api/session') {
        dropWorkspace(token);
        return json(res, 200, { ok: true });
      }
      if (method === 'GET' && path === '/api/session') return json(res, 200, publicSession(s));
      // The face picture itself. It is not part of the session JSON, which every request returns.
      if (method === 'GET' && path === '/api/portrait') {
        requireThat(s.portrait, 'There is no picture yet.', 404);
        const bytes = Buffer.from(s.portrait.image, 'base64');
        res.writeHead(200, { 'Content-Type': s.portrait.type, 'Content-Length': bytes.length });
        return res.end(bytes);
      }
      if (method === 'DELETE' && path === '/api/portrait') {
        requireThat(!s.portraitController, 'A picture is being drawn. Wait for it to finish.', 409);
        s.portrait = null; persist(s);
        return json(res, 200, publicSession(s));
      }
      requireThat(method === 'POST', 'Not found.', 404);
      if (path === '/api/transcribe') {
        requireThat(speech, 'Voice input is not configured on this server.', 503);
        requireThat(voiceAllowed(s), VOICE_STAGE, 409);
        requireThat(!s.speechController, 'A recording is already being transcribed.', 409);
        requireThat(s.transcriptions < SPEECH_LIMITS.perSession,
          'This session has reached its voice limit. Type your answers instead.', 429);
        const { type, audio } = await audioBody(req);
        requireThat(sessions.get(token) === s, 'Session was reset. Start again.', 401);
        const controller = new AbortController(), disconnected = () => { if (!res.writableEnded) controller.abort(); };
        s.speechController = controller; s.transcriptions += 1; res.on('close', disconnected);
        try {
          const result = await speech.transcribe(audio, { type, signal: controller.signal });
          // Returned for the participant to check and edit; it is not an answer until they send it.
          return json(res, 200, { text: result.text });
        } finally { res.off('close', disconnected); delete s.speechController; s.touched = Date.now(); }
      }
      const input = await body(req);
      requireThat(sessions.get(token) === s, 'Session was reset. Start again.', 401);
      if (path === '/api/transcribe/live') {
        requireThat(speech?.live, 'Live transcription is not available on this server.', 503);
        requireThat(voiceAllowed(s), VOICE_STAGE, 409);
        requireThat(s.transcriptions < SPEECH_LIMITS.perSession,
          'This session has reached its voice limit. Type your answers instead.', 429);
        s.transcriptions += 1;
        // A short-lived token for one recording; the browser shows the words as they are recognised.
        return json(res, 200, await speech.liveSession());
      }
      // The face is described before the interview and drawn while it runs (or later, in the conversation).
      // Drawing uses the image service, not the Claude lock, except for one short Claude look at the result.
      if (path === '/api/portrait') {
        requireThat(portraits, 'Character pictures are not set up on this server.', 503);
        requireThat(['intake', 'twin'].includes(s.stage),
          'Describe your face before the interview, or draw it once you meet your future self.', 409);
        requireThat(!s.portraitController, 'A picture is already being drawn.', 409);
        requireThat(s.portraitCount < PORTRAIT_LIMITS.perTwin,
          `This twin has reached its limit of ${PORTRAIT_LIMITS.perTwin} pictures. Keep the current face or remove it.`, 429);
        const description = text(input.description, 'Description', PORTRAIT_LIMITS.description, 3);
        const controller = new AbortController(), disconnected = () => { if (!res.writableEnded) controller.abort(); };
        s.portraitController = controller; res.on('close', disconnected);
        try {
          const drawn = await portraits.draw(description, { signal: controller.signal, safetyId: s.portraitSafetyId });
          s.portraitCount += 1; // Counted once a picture exists: that is what is billed.
          // During the interview the lock is usually free while the participant types; wait up to a minute.
          let points = structuredClone(DEFAULT_FACE_POINTS);
          if (await lockFree(60000, controller.signal)) {
            modelBusy = true; lockedForFace = true;
            try { points = await locateFace(model, drawn, controller.signal); } finally { modelBusy = false; lockedForFace = false; }
          }
          requireThat(sessions.get(token) === s, 'Session was reset. Start again.', 401);
          s.portrait = { version: (s.portrait?.version || 0) + 1, description, type: drawn.type, image: drawn.image, points,
            model: drawn.model, createdAt: new Date().toISOString() };
          return json(res, 200, publicSession(s));
        } finally { res.off('close', disconnected); delete s.portraitController; s.touched = Date.now(); }
      }
      requireThat(!s.controller, 'A response is already being generated.', 409);
      // Voice mode only shapes wording (speakable text); it never changes state or evidence.
      if (['/api/interview/next', '/api/answer'].includes(path)) s.voiceMode = input.voice === true;
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
        s.messages = []; s.problemThreads = {}; s.stage = 'prepare'; s.metrics = null; s.notice = '';
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
        // A focused session on one confirmed problem has its own thread and limit, next to the main conversation.
        const problem = input.problemId ? s.profile?.problems?.find(item => item.id === input.problemId) : null;
        requireThat(!input.problemId || problem, 'This problem is not part of your current profile.', 400);
        requireThat(!problem || ['open', 'say'].includes(action), 'A problem session takes your own messages only.');
        const thread = problem ? (s.problemThreads[problem.id] ||= []) : s.messages, limit = problem ? PROBLEM_EXCHANGES : 8;
        requireThat((action === 'open') === (thread.length === 0), 'Open the scene once, then continue the conversation.', 409);
        requireThat(thread.filter(m => m.role === 'user').length < limit, problem
          ? `Each problem session is limited to ${limit} exchanges. Pick another problem or go back to the conversation.`
          : 'This demo is limited to eight exchanges. Finish or edit your profile to restart.', 409);
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
            const voiceMode = input.voice === true;
            const output = await model.chat(problem ? problemMessages(s, problem, action, userText, { voice: voiceMode })
              : twinMessages(s, action, userText, { includeSample: action === 'demo' || selected?.kind === 'draft', voice: voiceMode }), {
              signal, onToken: value => emit({ type: 'token', text: value })
            });
            signal.throwIfAborted();
            // Commit only a completed exchange, never an interrupted half-answer.
            if (action !== 'open') {
              thread.push({
                role: 'user',
                content: selected ? selected.label : userText,
                source: action === 'say' ? 'typed' : 'suggestion',
                ...(selected ? { request: selected.request } : {})
              });
            }
            thread.push({ role: 'assistant', content: output.text });
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
    clearInterval(timer); clearInterval(purgeTimer);
    for (const s of sessions.values()) s.controller?.abort();
    sessions.clear();
  });
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 3000);
  requireThat(Number.isInteger(port) && port >= 1024 && port <= 65535, 'Invalid PORT.');
  const store = createStore(), server = createApp(undefined, undefined, store);
  server.listen(port, '127.0.0.1', () => {
    console.log(`Future Self: http://127.0.0.1:${port}`);
    console.log(store ? `Saved accounts: on (database: ${store.path})`
      : 'Saved accounts: off (guest only). Run npm.cmd run init:storage, then restart.');
  });
  server.on('error', error => { console.error(error.message); process.exitCode = 1; });
}
