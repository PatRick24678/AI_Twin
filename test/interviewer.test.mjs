import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../server.mjs';
import { AppError, sourcesFor } from '../lib/domain.mjs';
import { createInterview, applyInterviewTurn, recordInterviewInput, workingProfile } from '../lib/interview-state.mjs';
import {
  interviewMessages, explicitInterviewControl, newInterviewUsage, advanceInterview,
  INTERVIEW_BUDGET, recordControlledAnswer
} from '../lib/interviewer.mjs';
import { fixtureInterviewTurn } from '../test-support/interview-fixture.mjs';

const question = (topic, text, gap = '') => ({
  acknowledgement: '', question: { topic, text, gap },
  observations: [], boundaries: [], retractions: [], stopQuote: ''
});
function opening() {
  const state = createInterview();
  return applyInterviewTurn(state, state.requestId, question('role', 'What do you do?'));
}
function outputNote(data, topic, statement, replacesId = '') {
  return { topic, statement, sourceMessageId: data.CURRENT_INPUT.id,
    quote: data.CURRENT_INPUT.text, replacesId };
}
class FakeModel {
  name = 'INTERVIEW-TEST-NO-REAL-API';
  calls = [];
  outputs = [];
  async health() { return { ok: true, model: this.name }; }
  async chat(messages, options = {}) {
    this.calls.push({ messages, options });
    options.signal?.throwIfAborted();
    let result = this.outputs.length ? this.outputs.shift() : fixtureInterviewTurn(messages);
    if (typeof result === 'function') result = await result(JSON.parse(messages[1].content), options.signal);
    if (result instanceof Error) throw result;
    return { text: typeof result === 'string' ? result : JSON.stringify(result),
      metrics: { firstTokenMs: 1, totalMs: 3, inputTokens: 100, outputTokens: 20,
        cacheReadTokens: 5, cacheWriteTokens: 7 } };
  }
}
async function fixture(t) {
  const model = new FakeModel();
  const server = createApp(model);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function call(path, data, token = '', method = 'POST', signal) {
    const response = await fetch(base + path, { method, signal,
      headers: { 'Content-Type': 'application/json', 'X-Future-Self': '1', Authorization: `Bearer ${token}` },
      ...(data === undefined ? {} : { body: JSON.stringify(data) })
    });
    const result = await response.json();
    return { status: response.status, body: result };
  }
  async function start() {
    const made = await call('/api/session', { name: 'Alex', consent: true });
    const token = made.body.token;
    const begun = await call('/api/interview/next', { requestId: made.body.session.interview.requestId }, token);
    assert.equal(begun.status, 200, JSON.stringify(begun.body));
    return { token, session: begun.body };
  }
  const send = (client, data) => call('/api/answer', {
    questionId: client.session.interview.questionId, ...data
  }, client.token);
  const state = token => call('/api/session', undefined, token, 'GET');
  return { model, call, start, send, state, base };
}

test('interview prompt sends original early answers, latest answer and tentative notes, not a six-message slice', () => {
  let state = opening();
  state = recordInterviewInput(state, { text: 'I arrange business trips.' });
  const data = JSON.parse(interviewMessages(state)[1].content);
  assert.equal(data.CURRENT_INPUT.id, state.pendingInput);
  assert.equal(data.transcript[0].text, 'What do you do?');
  assert.equal(data.transcript.at(-1).text, 'I arrange business trips.');
  const instructions = interviewMessages(state)[0].content;
  assert.match(instructions, /Brevity is not lack of information/);
  assert.match(instructions, /not the twin or a salesperson/);
  assert.match(instructions, /untrusted reference data/);
  assert.match(instructions, /Do not re-add superseded/);
});

test('one normal interview step uses one structured call and no text streaming callback', async () => {
  const model = new FakeModel(), usage = newInterviewUsage(), state = createInterview();
  const result = await advanceInterview(model, state, usage);
  assert.equal(result.state.status, 'waiting');
  assert.equal(model.calls.length, 1);
  assert.equal(model.calls[0].options.onToken, undefined);
  assert.ok(model.calls[0].options.schema.properties.observations);
  assert.equal(usage.inputTokens, 100);
  assert.equal(usage.outputTokens, 20);
  assert.equal(usage.cacheReadTokens, 5);
});

test('invalid JSON gets one repair; neither attempt can partially mutate interview state', async () => {
  const model = new FakeModel(), usage = newInterviewUsage(), state = createInterview();
  model.outputs = ['invalid json'];
  const result = await advanceInterview(model, state, usage);
  assert.equal(model.calls.length, 2);
  assert.equal(usage.repairs, 1);
  assert.equal(usage.inputTokens, 200); // Invalid output is still reported usage.
  assert.equal(state.messages.length, 0);
  assert.equal(result.state.messages.length, 1);
  assert.match(model.calls[1].messages[0].content, /CORRECTION TO YOUR LAST ATTEMPT/);
});

test('semantic rule violations also get one repair, without accepting a blocked topic', async () => {
  const model = new FakeModel(), usage = newInterviewUsage();
  const state = recordInterviewInput(opening(), { kind: 'skip' });
  model.outputs = [question('role', 'Which role do you have?', 'Still unknown.'),
    question('retain', 'What do you enjoy doing yourself?')];
  const result = await advanceInterview(model, state, usage);
  assert.equal(result.state.topics.role.status, 'skipped');
  assert.equal(result.state.activeQuestion.topic, 'retain');
  assert.equal(model.calls.length, 2);
});

test('API errors are not automatically retried and usage is honestly marked unknown', async () => {
  const model = new FakeModel(), usage = newInterviewUsage();
  model.outputs = [new AppError(429, 'Test rate limit')];
  await assert.rejects(advanceInterview(model, createInterview(), usage), /rate limit/);
  assert.equal(model.calls.length, 1);
  assert.equal(usage.unknownUsageRequests, 1);
});

test('exact stop/decline shortcuts do not misclassify task descriptions', () => {
  for (const text of ['stop', "Let's stop here.", 'I want to stop the interview', "I'm done"]) {
    assert.equal(explicitInterviewControl(text), 'stop');
  }
  for (const text of ['skip', 'skip this question', "I'd rather not answer that", 'I would prefer not to answer']) {
    assert.equal(explicitInterviewControl(text), 'skip');
  }
  for (const text of ['Stop sending client emails.', 'I want to stop chasing updates.', 'My manager said stop.']) {
    assert.equal(explicitInterviewControl(text), null);
  }
});

test('explicit skip preserves its boundary before generation and cannot become profile evidence', () => {
  const state = recordControlledAnswer(opening(), "I'd rather not answer that");
  assert.equal(state.topics.role.status, 'skipped');
  assert.equal(state.messages.at(-1).kind, 'skip');
  assert.equal(state.messages.at(-1).text, '');
  assert.equal(state.messages.at(-1).displayText, "I'd rather not answer that");
});

test('per-turn and overall request budgets reject before another API request', async () => {
  const model = new FakeModel(), state = createInterview();
  let usage = newInterviewUsage(); usage.perRequest[state.requestId] = INTERVIEW_BUDGET.attemptsPerTurn;
  await assert.rejects(advanceInterview(model, state, usage), /limit/);
  usage = newInterviewUsage(); usage.attempts = INTERVIEW_BUDGET.attemptsTotal;
  await assert.rejects(advanceInterview(model, state, usage), /limit/);
  assert.equal(model.calls.length, 0);
});

test('cancelled generation does not commit a late otherwise valid result', async () => {
  const model = new FakeModel(), usage = newInterviewUsage(), state = createInterview();
  const controller = new AbortController();
  model.outputs = [() => { controller.abort(); return question('role', 'What do you do?'); }];
  await assert.rejects(advanceInterview(model, state, usage, controller.signal));
  assert.equal(state.messages.length, 0);
});

test('the evidence view uses active observation IDs, not answer1–answer4 or retired facts', () => {
  let state = recordInterviewInput(opening(), { text: 'I write reports.' });
  let data = JSON.parse(interviewMessages(state)[1].content);
  let turn = question('friction', 'What gets in the way?');
  turn.observations = [outputNote(data, 'role', 'Writes reports.')];
  state = applyInterviewTurn(state, state.requestId, turn);
  const oldId = state.observations[0].id;
  state = recordInterviewInput(state, { text: 'Actually, I review reports.' });
  data = JSON.parse(interviewMessages(state)[1].content);
  turn = question('retain', 'What would you retain?');
  turn.observations = [outputNote(data, 'role', 'Reviews reports.', oldId)];
  state = applyInterviewTurn(state, state.requestId, turn);
  const sources = sourcesFor({ interview: state, answers: [], sample: null });
  assert.equal(sources.length, 1);
  assert.equal(sources[0].interpretation, 'Reviews reports.');
  assert.equal(sources[0].text, 'Actually, I review reports.');
  assert.notEqual(sources[0].id, oldId);
  assert.ok(!JSON.stringify(sources).includes('I write reports.'));
  assert.ok(!Object.hasOwn(sources[0], 'confirmed'));
});

test('HTTP opening is model-generated, follow-ups are not chosen by an answer index', async t => {
  const f = await fixture(t), a = await f.start();
  f.model.outputs = [data => {
    const turn = question('workflow', 'How did you resolve the conflicting dates before telling the client?');
    turn.observations = [outputNote(data, 'friction', 'Encountered conflicting delivery dates.')];
    return turn;
  }];
  const result = await f.send(a, { text: 'The board said Wednesday but the developer said Friday.' });
  assert.equal(result.status, 200);
  assert.match(result.body.intake.at(-1).content, /conflicting dates/);
  assert.equal(result.body.interview.turns, 1);
  assert.equal(f.model.calls.length, 2); // Opening + current answer.
  assert.equal(result.body.interview.observationCount, 1);
});

test('HTTP retry after failure keeps one answer, rejects resubmission and finishes pending generation', async t => {
  const f = await fixture(t), a = await f.start();
  f.model.outputs = [new AppError(503, 'Simulated offline')];
  const failed = await f.send(a, { text: 'I coordinate projects.' });
  assert.equal(failed.status, 503);
  assert.equal(failed.body.session.interview.status, 'thinking');
  assert.equal(failed.body.session.intake.filter(m => m.role === 'user').length, 1);
  assert.equal((await f.send(a, { text: 'I coordinate projects.' })).status, 409);
  const retried = await f.call('/api/interview/next', {
    requestId: failed.body.session.interview.requestId
  }, a.token);
  assert.equal(retried.status, 200);
  assert.equal(retried.body.intake.filter(m => m.role === 'user').length, 1);
  assert.equal(retried.body.interview.status, 'waiting');
  assert.equal(retried.body.interview.usage.unknownUsageRequests, 1);
});

test('HTTP skip boundary survives a provider error and is present in the retried prompt', async t => {
  const f = await fixture(t), a = await f.start();
  f.model.outputs = [new AppError(503, 'offline'), question('retain', 'What would you retain?')];
  const failed = await f.send(a, { kind: 'skip' });
  const retry = await f.call('/api/interview/next', {
    requestId: failed.body.session.interview.requestId
  }, a.token);
  assert.equal(retry.status, 200);
  const data = JSON.parse(f.model.calls.at(-1).messages[1].content);
  assert.equal(data.topicState.role.status, 'skipped');
  assert.ok(!data.availableTopics.includes('role'));
  assert.equal(retry.body.interview.observationCount, 0);
});

test('HTTP exact stop works without another model call and permits only the post-interview transition', async t => {
  const f = await fixture(t), a = await f.start();
  assert.equal((await f.call('/api/interview/continue', {}, a.token)).status, 409);
  const ended = await f.send(a, { text: "Let's stop here." });
  assert.equal(ended.status, 200);
  assert.equal(ended.body.interview.finishReason, 'participant');
  assert.equal(f.model.calls.length, 1);
  assert.equal(ended.body.interview.observationCount, 0);
  const next = await f.call('/api/interview/continue', {}, a.token);
  assert.equal(next.body.stage, 'sample');
  assert.equal((await f.send(a, { text: 'A late answer.' })).status, 409);
});

test('HTTP natural-language stopping detected by the model uses quoted evidence', async t => {
  const f = await fixture(t), a = await f.start();
  f.model.outputs = [data => ({ ...question('none', ''), stopQuote: data.CURRENT_INPUT.text })];
  const result = await f.send(a, { text: 'I need to leave now, please finish the interview.' });
  assert.equal(result.body.interview.finishReason, 'participant');
  assert.equal(f.model.calls.length, 2);
});

test('HTTP old or cross-session question/request IDs do not trigger model usage', async t => {
  const f = await fixture(t), a = await f.start(), b = await f.start();
  const calls = f.model.calls.length;
  assert.equal((await f.call('/api/answer', { questionId: a.session.interview.questionId, text: 'Hello' }, b.token)).status, 409);
  assert.equal((await f.call('/api/interview/next', { requestId: 'wrong-id' }, b.token)).status, 409);
  assert.equal(f.model.calls.length, calls);
  const sent = await f.send(a, { text: 'I coordinate projects.' });
  assert.equal(sent.status, 200);
  assert.equal((await f.send(a, { text: 'Duplicate' })).status, 409);
});

test('HTTP invalid output repairs are capped and exhausted turns finish without fabricated facts', async t => {
  const f = await fixture(t), a = await f.start();
  f.model.outputs = ['bad', 'bad', 'bad', 'bad'];
  const first = await f.send(a, { text: 'Admin.' });
  assert.equal(first.status, 502);
  assert.equal(first.body.session.interview.status, 'thinking');
  const last = await f.call('/api/interview/next', {
    requestId: first.body.session.interview.requestId
  }, a.token);
  assert.equal(last.status, 502);
  assert.equal(last.body.session.interview.status, 'complete');
  assert.equal(last.body.session.interview.finishReason, 'processing_limit');
  assert.equal(last.body.session.interview.observationCount, 0);
  assert.equal(f.model.calls.length, 5); // Opening + maximum four attempts on one input.
  assert.equal((await f.call('/api/interview/next', { requestId: null }, a.token)).status, 409);
});

test('HTTP failure and reset cancel pending work without hanging or reviving the session', async t => {
  const f = await fixture(t), a = await f.start();
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  let cancelled = false;
  f.model.outputs = [(_, signal) => new Promise((resolve, reject) => {
    entered();
    signal.addEventListener('abort', () => { cancelled = true; reject(signal.reason); }, { once: true });
  })];
  const pending = f.send(a, { text: 'I coordinate projects.' });
  await started;
  assert.equal((await f.send(a, { text: 'Double click.' })).status, 409);
  await f.call('/api/session', undefined, a.token, 'DELETE');
  assert.equal((await pending).status, 409);
  assert.equal(cancelled, true);
  assert.equal((await f.state(a.token)).status, 401);
});

test('HTTP another session being busy does not consume or discard the new answer', async t => {
  const f = await fixture(t), a = await f.start(), b = await f.start();
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  f.model.outputs = [data => new Promise(resolve => {
    entered(); release = () => resolve(fixtureInterviewTurn([{ role: 'system', content: '' }, { role: 'user', content: JSON.stringify(data) }]));
  })];
  const pending = f.send(a, { text: 'I coordinate projects.' });
  await started;
  const blocked = await f.send(b, { text: 'I arrange trips.' });
  assert.equal(blocked.status, 429);
  const state = (await f.state(b.token)).body;
  assert.equal(state.interview.turns, 0);
  assert.equal(state.interview.status, 'waiting');
  release();
  assert.equal((await pending).status, 200);
});

test('HTTP early sparse ending does not generate profile facts and keeps optional sample flow gated', async t => {
  const f = await fixture(t), a = await f.start();
  let state = a.session;
  f.model.outputs = [question('workflow', 'What happens in a typical task?'),
    question('retain', 'What would you keep doing yourself?'), question('none', '')];
  for (let i = 0; i < 3; i++) {
    const result = await f.call('/api/answer', { questionId: state.interview.questionId, kind: 'skip' }, a.token);
    assert.equal(result.status, 200); state = result.body;
  }
  assert.equal(state.interview.status, 'complete');
  assert.equal(state.interview.observationCount, 0);
  assert.deepEqual(state.claims, []);
  assert.equal((await f.call('/api/profile', { facts: ['Invented', 'Invented'] }, a.token)).status, 409);
  await f.call('/api/interview/continue', {}, a.token);
  const before = f.model.calls.length;
  const noEvidence = await f.call('/api/sample', { text: '', context: '', style: 'none' }, a.token);
  assert.equal(noEvidence.status, 200);
  assert.equal(noEvidence.body.stage, 'review');
  assert.deepEqual(noEvidence.body.profileDraft.entries, []);
  assert.equal(f.model.calls.length, before); // No billable attempt to manufacture a profile.
});

test('model adapter passes stable interview schema through to Claude without secrets in prompt', async () => {
  const { AnthropicModel } = await import('../lib/anthropic-model.mjs');
  let sent;
  const state = createInterview();
  const reply = question('role', 'What do you do?');
  const model = new AnthropicModel({ apiKey: 'test-only-placeholder', fetcher: async (url, options) => {
    sent = JSON.parse(options.body);
    const events = [
      { type: 'message_start', message: { usage: { input_tokens: 20, cache_read_input_tokens: 10, cache_creation_input_tokens: 30 } } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: JSON.stringify(reply) } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 40 } },
      { type: 'message_stop' }
    ];
    return new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(''), {
      headers: { 'content-type': 'text/event-stream' }
    });
  } });
  const usage = newInterviewUsage();
  const result = await advanceInterview(model, state, usage);
  assert.equal(result.state.status, 'waiting');
  assert.equal(sent.output_config.format.type, 'json_schema');
  assert.ok(sent.output_config.format.schema.properties.question);
  assert.ok(!JSON.stringify(sent).includes('test-only-placeholder'));
  assert.equal(usage.inputTokens, 20);
  assert.equal(usage.cacheReadTokens, 10);
  assert.equal(usage.cacheWriteTokens, 30);
});
