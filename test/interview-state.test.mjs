import test from 'node:test';
import assert from 'node:assert/strict';
import {
  INTERVIEW_TOPICS, INTERVIEW_LIMITS, validateInterviewTurn
} from '../lib/interview-contract.mjs';
import {
  createInterview, recordInterviewInput, applyInterviewTurn,
  availableTopics, workingProfile, interviewPace, unexploredAgenda, mustChangeSubject, withoutStockPhrases
} from '../lib/interview-state.mjs';

// These fabricated outputs test the rules, not a real model's understanding.
function output(topic = 'role', text = 'What do you do?') {
  return {
    acknowledgement: '', question: { topic, text, gap: '', move: 'new_area', last: false },
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
  clarify.question.gap = 'No concrete responsibility has been described.'; clarify.question.move = 'follow_up';
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
  assert.throws(() => apply(state, finished()), /end abruptly/);
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
  const typical = output('role', 'What is a typical task?'); typical.question.move = 'follow_up';
  assert.throws(() => apply(state, typical), /unresolved gap/);
  const repeated = output('role', 'WHAT DO YOU DO!');
  repeated.question.gap = 'Still unclear.'; repeated.question.move = 'follow_up';
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

// Answers the active question with one note on its topic, then asks `next` (topic, last flag).
function step(state, i, topic, last = false) {
  const asked = state.activeQuestion.topic;
  state = answer(state, `Concrete fictional answer ${i}.`);
  const value = output(topic, `Unique question ${i}?`);
  value.question.gap = 'A further concrete detail.'; value.question.last = last;
  value.question.move = state.topics[topic].asked ? 'follow_up' : 'new_area';
  value.observations = [note(state, asked, `Detail ${i}.`)];
  return apply(state, value);
}

test('a rich first answer cannot end abruptly; the last question comes at the target and is signposted', () => {
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
  assert.throws(() => apply(state, value), /end abruptly/);
  value.question = { topic: 'tasks', text: 'Which tasks recur each week?', gap: '', move: 'new_area', last: true };
  state = apply(state, value);
  assert.equal(state.activeQuestion.last, false); // Question 2: too early, corrected rather than rejected.
  state = step(state, 3, 'tools');
  assert.deepEqual([interviewPace(state).pace, interviewPace(state).lastAllowed], ['exploring', false]);
  state = step(state, 4, 'quality');
  assert.deepEqual([interviewPace(state).pace, interviewPace(state).lastAllowed], ['wrapping_up', true]);
  state = step(state, 5, 'decisions');
  assert.equal(state.activeQuestion.last, false); // Question 5: allowed, but the model chose to continue.
  state = step(state, 6, 'ai_experience');
  assert.equal(state.activeQuestion.last, true); // Question 6 with the core covered: required.
  state = answer(state, 'Curious, a little wary.');
  const closing = output('desired_change', 'Ignored follow-up?');
  closing.acknowledgement = 'Curious and a little wary sounds like a good place to start. Thank you.';
  state = apply(state, closing);
  assert.deepEqual([state.finishReason, state.turns, state.messages.at(-1).kind], ['coverage', 6, 'closing']);
  assert.equal(state.messages.at(-1).text, closing.acknowledgement);
  assert.equal(state.questions.length, 6);
  // Source-backed extractions are still interpretations, not participant approval.
  assert.ok(state.observations.every(n => n.status === 'tentative'));
});

test('without core coverage the last question is forced by question 8; skipping it ends the interview', () => {
  let state = opening('tasks');
  assert.deepEqual(interviewPace(createInterview()), { questionNumber: 1, targetQuestions: INTERVIEW_LIMITS.targetTurns,
    pace: 'exploring', lastAllowed: false, lastRequired: false });
  const topics = ['tools', 'quality', 'decisions', 'ai_experience', 'desired_change', 'dependencies', 'tasks'];
  for (let i = 2; i <= INTERVIEW_LIMITS.latestLastQuestion; i++) {
    const pace = interviewPace(state);
    assert.equal(pace.pace, i < INTERVIEW_LIMITS.targetTurns - 1 ? 'exploring' : 'wrapping_up');
    assert.equal(pace.lastAllowed, i === INTERVIEW_LIMITS.latestLastQuestion); // Never earlier without the core.
    state = step(state, i, topics[i - 2]);
  }
  assert.equal(state.questions.length, INTERVIEW_LIMITS.latestLastQuestion);
  assert.equal(state.activeQuestion.last, true);
  state = apply(recordInterviewInput(state, { kind: 'skip' }), output('tools', 'Ignored?'));
  assert.equal(state.finishReason, 'limited_context');
  assert.match(state.messages.at(-1).text, /leave the remaining details unknown/); // Fallback closing.
  assert.throws(() => answer(state, 'Another answer.'));
});

test('a question about the interview itself is not a stop request', () => {
  let state = answer(opening(), 'How much longer is this going to take?');
  const value = output('retain', 'What part of your week would you never hand over?');
  value.acknowledgement = 'Just a few more questions.';
  state = apply(state, value);
  assert.equal(state.status, 'waiting');
  assert.equal(state.finishReason, null);
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

test('after a skip the interviewer must open a new area, not a similar-sounding follow-up', () => {
  let state = answer(opening(), 'I recruit salespeople.');
  const first = output('friction', 'What slows your hiring down?');
  first.observations = [note(state, 'role', 'Recruits salespeople.')];
  state = recordInterviewInput(apply(state, first), { kind: 'skip' });
  assert.equal(mustChangeSubject(state), true);
  const similar = output('role', 'Which part of recruiting feels slowest?');
  similar.question.gap = 'Slowdowns.'; similar.question.move = 'follow_up';
  assert.throws(() => apply(state, similar), /After a skip, change the subject.*retain, ai_experience/);
  assert.throws(() => apply(state, { ...similar, question: { ...similar.question, move: 'new_area' } }), /not asked about yet/);
  state = apply(state, output('retain', 'Which part of your job would you never hand over?'));
  assert.equal(state.followUpStreak, 0);
});

test('at most one follow-up in a row; the agenda then decides the next area', () => {
  let state = answer(opening(), 'I recruit salespeople.');
  const follow = output('role', 'Who do you recruit for most often?');
  follow.question.gap = 'Which teams.'; follow.question.move = 'follow_up';
  follow.observations = [note(state, 'role', 'Recruits salespeople.')];
  state = apply(state, follow);
  assert.equal(state.followUpStreak, 1);
  state = answer(state, 'Mostly the field sales team.');
  assert.equal(mustChangeSubject(state), true);
  const again = output('role', 'How big is that team?');
  again.question.gap = 'Team size.'; again.question.move = 'follow_up';
  assert.throws(() => apply(state, again), /already asked one follow-up/);
  state = apply(state, output('ai_experience', 'How do you feel about AI showing up in hiring?'));
  assert.equal(state.followUpStreak, 0);
});

test('once no unexplored areas remain, consecutive follow-ups are allowed again', () => {
  let state = answer(opening(), 'Only my role, nothing else please.');
  const value = output('role', 'What does a normal day look like?');
  value.question.gap = 'Ordinary day.'; value.question.move = 'follow_up';
  value.boundaries = Object.keys(INTERVIEW_TOPICS).filter(id => id !== 'role').map(topic => ({
    topic, reason: 'declined', sourceMessageId: state.pendingInput, quote: 'nothing else please' }));
  state = apply(state, value);
  assert.deepEqual(unexploredAgenda(state), []);
  state = answer(state, 'Interviews and calls.');
  const more = output('role', 'Which calls matter most to you?');
  more.question.gap = 'Priorities.'; more.question.move = 'follow_up';
  more.observations = [note(state, 'role', 'Interviews and calls.')];
  assert.equal(apply(state, more).followUpStreak, 2);
});

test('stock filler is stripped from acknowledgements; specific reactions and closings are kept', () => {
  for (const stock of ['Thanks for letting me know.', 'Thank you!', 'Thanks, that gives a clear picture of your day.',
    "That's really helpful.", 'That makes sense.', 'Feedback delays can definitely be frustrating.']) {
    assert.equal(withoutStockPhrases(stock), '', stock);
  }
  assert.equal(withoutStockPhrases('Thanks for sharing. Weeks? That is a long time to keep someone waiting.'),
    'Weeks? That is a long time to keep someone waiting.');
  assert.equal(withoutStockPhrases('Just two more questions.'), 'Just two more questions.');
  let state = answer(opening(), 'Feedback takes weeks.');
  const value = output('retain', 'What would you never hand over?');
  value.acknowledgement = 'Thanks for letting me know.';
  state = apply(state, value);
  assert.equal(state.messages.at(-1).text, 'What would you never hand over?');
});
