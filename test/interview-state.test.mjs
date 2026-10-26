import test from 'node:test';
import assert from 'node:assert/strict';
import {
  INTERVIEW_TOPICS, INTERVIEW_LIMITS, validateInterviewTurn
} from '../lib/interview-contract.mjs';
import {
  createInterview, recordInterviewInput, applyInterviewTurn,
  availableTopics, workingProfile
} from '../lib/interview-state.mjs';

// These fabricated outputs test the rules, not a real model's understanding.
function output(topic = 'role', text = 'What do you do?') {
  return {
    acknowledgement: '', question: { topic, text, gap: '' },
    observations: [], boundaries: [], retractions: [], stopQuote: ''
  };
}
function apply(state, value) {
  return applyInterviewTurn(state, state.requestId, value);
}
function opening(topic = 'role') {
  return apply(createInterview(), output(topic));
}
function answer(state, text) {
  return recordInterviewInput(state, { kind: 'answer', text });
}
function note(state, topic, statement, replacesId = '') {
  const input = state.messages.find(m => m.id === state.pendingInput);
  return {
    topic, statement, sourceMessageId: input.id,
    quote: input.text, replacesId
  };
}
function finished() {
  return output('none', '');
}

test('opening is proposed by the interviewer; each interview has isolated state', () => {
  const a = createInterview(), b = createInterview();
  assert.notEqual(a.requestId, b.requestId);
  const next = apply(a, output());
  assert.equal(next.status, 'waiting');
  assert.equal(next.activeQuestion.topic, 'role');
  assert.equal(next.messages.length, 1);
  assert.equal(a.messages.length, 0);
  assert.equal(b.questions.length, 0);
});

test('blank, oversized and overlapping answers are rejected', () => {
  const state = opening();
  assert.throws(() => answer(state, '   '));
  assert.throws(() => answer(state, 'a'.repeat(INTERVIEW_LIMITS.answerCharacters + 1)));
  const pending = answer(state, 'I coordinate website projects.');
  assert.throws(() => answer(pending, 'A second answer.'));
  assert.equal(state.turns, 0);
  assert.equal(pending.turns, 1);
});

test('a brief informative answer can establish an evidence-linked tentative observation', () => {
  let state = answer(opening(), 'I arrange business trips.');
  const value = output('workflow', 'What happened on the last trip you arranged?');
  value.observations = [note(state, 'role', 'Arranges business trips.')];
  state = apply(state, value);
  assert.equal(state.topics.role.status, 'covered');
  assert.equal(state.topics.role.misses, 0);
  assert.equal(workingProfile(state).observations[0].status, 'tentative');
  assert.ok(workingProfile(state).unknownTopics.some(t => t.topic === 'tools'));
});

test('unsupported evidence and model-supplied confirmation fields are rejected atomically', () => {
  const state = answer(opening(), 'I arrange business trips.');
  const value = output('workflow', 'Walk me through your last task.');
  value.observations = [note(state, 'role', 'Arranges trips.')];
  const before = JSON.stringify(state);
  value.observations.push({ ...value.observations[0], topic: 'tools', quote: 'I use Jira' });
  assert.throws(() => apply(state, value), /supporting quote/);
  assert.equal(JSON.stringify(state), before);
  value.observations.pop();
  value.observations[0].confirmed = true;
  assert.throws(() => apply(state, value), /unexpected fields/);
});

test('an assistant message cannot be cited as evidence', () => {
  const state = answer(opening(), 'I arrange trips.');
  const value = output('workflow', 'What happens first?');
  value.observations = [{
    ...note(state, 'role', 'Arranges trips.'),
    sourceMessageId: state.messages[0].id
  }];
  assert.throws(() => apply(state, value), /participant answer/);
});

test('a bare yes cannot become blanket confirmation of invented personal details', () => {
  const state = answer(opening(), 'yeah');
  const value = output('workflow', 'What happens first?');
  value.observations = [note(state, 'role', 'Manages eight developers.')];
  assert.throws(() => apply(state, value), /acknowledgement alone/);
});

test('one unsuccessful clarification is allowed, but a third probe is blocked', () => {
  let state = answer(opening(), 'Admin.');
  const clarify = output('role', 'What is one task you did today?');
  clarify.question.gap = 'No concrete responsibility has been described.';
  state = apply(state, clarify);
  state = answer(state, 'Not sure.');
  const third = output('role', 'Can you give me more about your role?');
  third.question.gap = 'Still no concrete task.';
  assert.throws(() => apply(state, third), /blocked or exhausted/);
  state = apply(state, output('retain', 'What do you enjoy doing yourself?'));
  assert.equal(state.topics.role.status, 'unclear');
  assert.ok(!availableTopics(state).includes('role'));
});

test('a skip blocks that focus without adding a personal observation', () => {
  let state = recordInterviewInput(opening('tools'), { kind: 'skip' });
  assert.ok(!availableTopics(state).includes('tools'));
  assert.ok(availableTopics(state).includes('communication'));
  assert.throws(() => apply(state, output('tools', 'Which software do you work with?')));
  state = apply(state, output('retain', 'What would you keep doing yourself?'));
  assert.deepEqual(workingProfile(state).observations, []);
});

test('a skip event cannot be used as profile evidence; stray model fields are ignored, not fatal', () => {
  let state = answer(opening(), 'I arrange business trips.');
  const first = output('tools', 'Which tools do you use?');
  first.observations = [note(state, 'role', 'Arranges business trips.')];
  state = apply(state, first);
  const kept = state.observations[0];
  state = recordInterviewInput(state, { kind: 'skip' });
  const value = output('workflow', 'Describe a recent task.');
  value.observations = [note(state, 'role', 'Does not enjoy work.')];
  value.boundaries = [{ topic: 'tools', reason: 'declined', sourceMessageId: state.pendingInput, quote: '' }];
  value.retractions = [{ observationId: kept.id, sourceMessageId: kept.sourceMessageId, quote: kept.quote }];
  value.stopQuote = 'Skipped this question.';
  state = apply(state, value);
  assert.equal(state.status, 'waiting');
  assert.equal(state.activeQuestion.topic, 'workflow');
  assert.deepEqual(workingProfile(state).observations.map(n => n.statement), ['Arranges business trips.']);
  assert.equal(state.topics.tools.status, 'skipped'); // A pause, not a recorded refusal.
  assert.equal(state.topics.tools.boundaryEvidence, null);
});

test('an opening still rejects stray evidence rather than ignoring it', () => {
  const state = createInterview();
  const value = output('role', 'What do you do?');
  value.boundaries = [{ topic: 'tools', reason: 'declined', sourceMessageId: 'x', quote: 'x' }];
  assert.throws(() => apply(state, value), /participant answer/);
});

test('a quoted refusal closes a topic without profiling the refusal', () => {
  let state = answer(opening('tools'), 'I do not want to discuss our tools.');
  const value = output('retain', 'What would you keep doing yourself?');
  value.boundaries = [{
    topic: 'tools', reason: 'declined',
    sourceMessageId: state.pendingInput,
    quote: 'I do not want to discuss our tools.'
  }];
  state = apply(state, value);
  assert.equal(state.topics.tools.status, 'declined');
  assert.equal(state.observations.length, 0);
  assert.ok(!availableTopics(state).includes('tools'));
});

test('a participant correction replaces, rather than duplicates, an active interpretation', () => {
  let state = answer(opening(), 'I write reports.');
  let value = output('friction', 'What gets in the way?');
  value.observations = [note(state, 'role', 'Writes reports.')];
  state = apply(state, value);
  const oldId = state.observations[0].id;
  state = answer(state, 'Actually I review reports, not write them.');
  value = output('retain', 'What do you want to retain?');
  value.observations = [note(state, 'role', 'Reviews reports.', oldId)];
  state = apply(state, value);
  assert.equal(state.observations[0].status, 'superseded');
  assert.deepEqual(workingProfile(state).observations.map(n => n.statement), ['Reviews reports.']);
});

test('an observation can be withdrawn without inventing a replacement', () => {
  let state = answer(opening(), 'I write reports.');
  let value = output('friction', 'What gets in the way?');
  value.observations = [note(state, 'role', 'Writes reports.')];
  state = apply(state, value);
  state = answer(state, 'That description was wrong. Remove it.');
  value = output('retain', 'What do you want to retain?');
  value.retractions = [{
    observationId: state.observations[0].id,
    sourceMessageId: state.pendingInput,
    quote: 'That description was wrong. Remove it.'
  }];
  state = apply(state, value);
  assert.equal(state.observations[0].status, 'retracted');
  assert.equal(workingProfile(state).observations.length, 0);
});

test('stopping while a request is pending invalidates a late model result', () => {
  const state = answer(opening(), 'I write reports.');
  const ended = recordInterviewInput(state, { kind: 'stop' });
  assert.equal(ended.finishReason, 'participant');
  assert.throws(() => applyInterviewTurn(ended, state.requestId, output()), /Stale/);
});

test('a spoken or typed stopping request needs a matching quote', () => {
  const state = answer(opening(), 'Let us stop here.');
  const value = finished();
  value.stopQuote = 'Let us stop here.';
  assert.equal(apply(state, value).finishReason, 'participant');
  value.stopQuote = 'Something the participant did not say.';
  assert.throws(() => apply(state, value), /supporting quote/);
});

test('an applied response cannot be replayed or used in another interview', () => {
  const a = createInterview(), b = createInterview();
  const next = apply(a, output());
  assert.throws(() => applyInterviewTurn(next, a.requestId, output()), /Stale/);
  assert.throws(() => applyInterviewTurn(b, a.requestId, output()), /Stale/);
});

test('an opening cannot fabricate a profile or immediately finish', () => {
  const state = createInterview();
  assert.throws(() => apply(state, finished()), /finish before/);
  const value = output();
  value.observations = [{
    topic: 'role',
    statement: 'Project manager.',
    sourceMessageId: 'invented',
    quote: 'Project manager.',
    replacesId: ''
  }];
  assert.throws(() => apply(state, value), /participant answer/);
});

test('follow-ups must identify a gap; near-identical punctuation is not a new question', () => {
  const state = answer(opening(), 'Admin.');
  assert.throws(() => apply(state, output('role', 'What is a typical task?')), /unresolved gap/);
  const repeated = output('role', 'WHAT DO YOU DO!');
  repeated.question.gap = 'Still unclear.';
  assert.throws(() => apply(state, repeated), /already been asked/);
});

test('three uninformative turns permit an honest sparse ending, not invented facts', () => {
  let state = opening();
  for (const topic of ['workflow', 'friction']) {
    state = answer(state, 'Not sure.');
    state = apply(state, output(topic, `Tell me about ${topic}.`));
  }
  state = answer(state, 'Not sure.');
  state = apply(state, finished());
  assert.equal(state.finishReason, 'limited_context');
  assert.equal(workingProfile(state).observations.length, 0);
  assert.equal(workingProfile(state).unknownTopics.length, Object.keys(INTERVIEW_TOPICS).length);
});

test('one rich answer covering every core area cannot end the interview before the minimum', () => {
  let state = answer(
    opening(),
    'I coordinate projects, review updates, dislike delays, write briefly and keep client calls.'
  );
  const value = finished();
  value.observations = [
    ['role', 'Coordinates projects.'],
    ['workflow', 'Reviews updates.'],
    ['friction', 'Dislikes delays.'],
    ['communication', 'Writes briefly.'],
    ['retain', 'Wants to keep client calls.']
  ].map(([topic, statement]) => note(state, topic, statement));
  assert.throws(() => apply(state, value), new RegExp(`at least ${INTERVIEW_LIMITS.minTurnsBeforeFinish}`));
  value.question = { topic: 'tasks', text: 'Which tasks recur each week?', gap: '' };
  state = apply(state, value);
  const secondary = ['tasks', 'tools', 'quality', 'decisions', 'ai_experience', 'desired_change', 'dependencies'];
  for (let i = 2; i <= INTERVIEW_LIMITS.minTurnsBeforeFinish; i++) {
    const topic = state.activeQuestion.topic;
    state = answer(state, `Concrete fictional answer ${i}.`);
    const close = finished();
    close.observations = [note(state, topic, `Detail ${i}.`)];
    if (i === INTERVIEW_LIMITS.minTurnsBeforeFinish) { state = apply(state, close); break; }
    assert.throws(() => apply(state, close), /before useful coverage/);
    const next = output(secondary[i % secondary.length], `Unique follow-up ${i}?`);
    next.question.gap = 'A further concrete detail.'; next.observations = close.observations;
    state = apply(state, next);
  }
  assert.equal(state.finishReason, 'coverage');
  assert.equal(state.turns, INTERVIEW_LIMITS.minTurnsBeforeFinish);
  // Source-backed extractions are still interpretations, not participant approval.
  assert.ok(state.observations.every(n => n.status === 'tentative'));
});

test('the final allowed answer is retained, then the controller enforces the limit', () => {
  const topics = Object.keys(INTERVIEW_TOPICS);
  let state = opening();
  for (let i = 0; i < INTERVIEW_LIMITS.turns; i++) {
    const topic = state.activeQuestion.topic;
    state = answer(state, `Concrete fictional answer number ${i}.`);
    const value = output(
      topics[(i + 1) % topics.length],
      `Unique question ${i + 1}?`
    );
    value.question.gap = 'An additional concrete detail.';
    value.observations = [note(state, topic, `Detail ${i}.`)];
    state = apply(state, value);
  }
  assert.equal(state.finishReason, 'turn_limit');
  assert.equal(state.observations.length, INTERVIEW_LIMITS.turns);
  assert.equal(state.questions.length, INTERVIEW_LIMITS.turns);
  assert.throws(() => answer(state, 'Another answer.'));
});

test('schemas reject unknown topics, oversized replies and arbitrary model fields', () => {
  const value = output();
  value.question.topic = 'medical_diagnosis';
  assert.throws(() => validateInterviewTurn(value));
  value.question.topic = 'role';
  value.acknowledgement = 'x'.repeat(201);
  assert.throws(() => validateInterviewTurn(value));
  value.acknowledgement = '';
  value.runShell = 'no';
  assert.throws(() => validateInterviewTurn(value));
});