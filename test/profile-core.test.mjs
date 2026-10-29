import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createInterview } from '../lib/interview-state.mjs';
import {
  PROFILE_LIMITS, createProfileDraft, applyProfileAudit, answerProfileQuestion, applyProfileAnswer,
  useProfileNotes, confirmProfile, profileContext
} from '../lib/profile-core.mjs';
import { profileAuditMessages, profileAnswerMessages, advanceProfile, canRetryProfile, PROFILE_BUDGET } from '../lib/profile-builder.mjs';
import { twinMessages } from '../lib/prompts.mjs';
import { suggestionMessages } from '../lib/suggestions.mjs';

const sample = () => ({ text: 'Please confirm the date. I need it for the update.', context: 'Internal request', authored: true, typical: true, style: 'none' });
const empty = () => ({ text: '', context: '', authored: false, typical: false, style: 'none' });
const audit = () => ({ sampleNotes: [], clarifications: [] });
function sourceSession() {
  const interview = createInterview(); interview.status = 'complete'; interview.finishReason = 'coverage';
  for (const [topic, statement] of [['role', 'I coordinate projects.'], ['communication', 'I prefer concise internal messages.'], ['retain', 'I keep final client approval.']]) {
    const message = { id: randomUUID(), role: 'user', kind: 'answer', text: statement };
    interview.messages.push(message);
    interview.observations.push({ id: randomUUID(), topic, statement, sourceMessageId: message.id, quote: statement, status: 'tentative' });
  }
  return { interview, profileVersion: 0, profile: null, answers: [], messages: [] };
}
function draftWithQuestion() {
  const draft = createProfileDraft(sourceSession(), sample());
  const value = audit();
  value.clarifications.push({ topic: 'communication', question: 'Do you write differently for clients?', reason: 'Audience may change the style.', entryIds: [draft.entries[1].id], usesSample: true });
  return applyProfileAudit(draft, value);
}
function submission(draft, entries = draft.entries.filter(e => e.included)) {
  return { profileVersion: 0, draftId: draft.id, acknowledged: true,
    entries: entries.map(({ id, topic, text, scope }) => ({ id, topic, text, scope })) };
}
function sessionWithDraft(draft) { return { ...sourceSession(), sample: draft.sample, profileDraft: draft }; }

// No live provider or credentials are used in this file.
test('seed retains exact active wording and evidence, excludes retired notes and merges exact same-topic duplicates', () => {
  const s = sourceSession();
  s.interview.observations.push({ ...s.interview.observations[0], id: randomUUID() });
  s.interview.observations.push({ ...s.interview.observations[0], id: randomUUID(), status: 'retracted', statement: 'REJECTED_DETAIL' });
  const draft = createProfileDraft(s, empty());
  assert.equal(draft.entries.length, 3);
  assert.equal(draft.entries[0].text, s.interview.observations[0].statement);
  assert.equal(draft.entries[0].evidence[0].sourceId, s.interview.messages[0].id);
  assert.ok(!JSON.stringify(draft).includes('REJECTED_DETAIL'));
  assert.ok(draft.entries.every(e => e.status === 'tentative'));
});
test('assistant messages and nonmatching quotes cannot seed personal facts', () => {
  const s = sourceSession(); s.interview.messages[0].role = 'assistant'; s.interview.observations[1].quote = 'Not actually supplied.';
  const draft = createProfileDraft(s, empty());
  assert.equal(draft.entries.length, 1); assert.equal(draft.entries[0].topic, 'retain');
});
test('audit receives current statements, not superseded notes or full interview transcript', () => {
  const s = sourceSession(); s.interview.messages.push({ id: 'old', role: 'assistant', kind: 'question', text: 'WITHDRAWN_HISTORY' });
  const prompt = JSON.stringify(profileAuditMessages(createProfileDraft(s, sample())));
  assert.ok(!prompt.includes('WITHDRAWN_HISTORY')); assert.match(prompt, /Do not rewrite/);
});
test('the profile is not limited to six facts or forced to reach a minimum count', () => {
  const s = sourceSession();
  for (let i = 0; i < 8; i++) {
    const m = { id: randomUUID(), role: 'user', kind: 'answer', text: `I handle task ${i}.` }; s.interview.messages.push(m);
    s.interview.observations.push({ id: randomUUID(), topic: 'tasks', statement: m.text, quote: m.text, sourceMessageId: m.id, status: 'tentative' });
  }
  const draft = applyProfileAudit(createProfileDraft(s, empty()), audit());
  const profile = confirmProfile(sessionWithDraft(draft), submission(draft));
  assert.equal(profile.entries.length, 11);
  assert.equal(confirmProfile(sessionWithDraft(draft), submission(draft, [draft.entries[0]])).entries.length, 1);
});
test('no personal evidence yields an empty review with no model step', () => {
  const draft = createProfileDraft({}, empty());
  assert.equal(draft.status, 'review'); assert.deepEqual(draft.entries, []); assert.equal(draft.requestId, null);
  assert.throws(() => confirmProfile(sessionWithDraft(draft), submission(draft)), /at least one/);
});
test('fictional example events never enter a profile; only the selected preference does', () => {
  const draft = createProfileDraft({}, { ...empty(), style: 'direct' });
  assert.equal(draft.entries.length, 1); assert.equal(draft.entries[0].origin, 'exercise_choice');
  assert.ok(!JSON.stringify(draft.entries).includes('Thursday'));
});
test('sample observations are scoped writing notes with sample evidence', () => {
  const draft = createProfileDraft(sourceSession(), sample()), value = audit();
  value.sampleNotes = [{ text: 'Starts the request with an action.', scope: 'This internal email.', quote: 'Please confirm the date.' }];
  const result = applyProfileAudit(draft, value), entry = result.entries.at(-1);
  assert.equal(entry.topic, 'communication'); assert.equal(entry.origin, 'sample'); assert.equal(entry.evidence[0].kind, 'sample');
  assert.equal(result.status, 'review'); assert.equal(draft.entries.length, 3);
});
test('sample scope, authorship, typicality and matching quotes are enforced', () => {
  const value = audit(); value.sampleNotes = [{ text: 'Concise request.', scope: 'Internal email.', quote: 'Please confirm the date.' }];
  for (const settings of [{ authored: false }, { typical: false }]) {
    assert.throws(() => applyProfileAudit(createProfileDraft(sourceSession(), { ...sample(), ...settings }), value), /self-authored/);
  }
  const draft = createProfileDraft(sourceSession(), sample());
  value.sampleNotes[0].scope = ''; assert.throws(() => applyProfileAudit(draft, value), /scope/);
  value.sampleNotes[0].scope = 'Internal'; value.sampleNotes[0].quote = 'Never supplied';
  assert.throws(() => applyProfileAudit(draft, value), /exact quote/);
});
test('conflict candidates are unchecked until clarified or explicitly reviewed', () => {
  const draft = draftWithQuestion(), id = draft.questions[0].entryIds[0];
  assert.equal(draft.status, 'clarifying');
  assert.equal(draft.entries.find(e => e.id === id).included, false);
  assert.equal(draft.entries.find(e => e.id === id).status, 'needs_review');
});
test('invented, repeated, blocked or excessive clarification references are rejected', () => {
  const draft = createProfileDraft(sourceSession(), sample());
  const q = { topic: 'communication', question: 'Is this typical?', reason: 'Check context.', entryIds: [draft.entries[1].id], usesSample: true };
  assert.throws(() => applyProfileAudit(draft, { sampleNotes: [], clarifications: [{ ...q, entryIds: ['other-session'] }] }), /current/);
  assert.throws(() => applyProfileAudit(draft, { sampleNotes: [], clarifications: [q, { ...q, question: 'And is it typical?', usesSample: false }] }), /twice/);
  draft.blockedTopics = ['communication'];
  assert.throws(() => applyProfileAudit(draft, { sampleNotes: [], clarifications: [q] }), /reopen/);
  assert.throws(() => applyProfileAudit(draft, { sampleNotes: [], clarifications: [{ ...q, topic: 'other', usesSample: false }] }), /blocked entry/);
  assert.throws(() => applyProfileAudit(draft, { sampleNotes: [], clarifications: [q, q, q] }), /too many/);
});
test('participant ending prevents a new round of clarification questions', () => {
  const s = sourceSession(); s.interview.finishReason = 'participant';
  const draft = createProfileDraft(s, sample());
  assert.equal(draft.allowQuestions, false);
  assert.throws(() => applyProfileAudit(draft, { sampleNotes: [], clarifications: [{ topic: 'role', question: 'More detail?', reason: 'A gap.', entryIds: [draft.entries[0].id], usesSample: false }] }), /asked to stop/);
});
test('skip leaves uncertainty explicit and performs no profile inference', () => {
  const draft = draftWithQuestion();
  const skipped = answerProfileQuestion(draft, { questionId: draft.questions[0].id, kind: 'skip' });
  assert.equal(skipped.status, 'review'); assert.equal(skipped.questions[0].status, 'skipped');
  assert.equal(skipped.entries[1].included, false); assert.equal(skipped.usage.attempts, 0);
  const profile = confirmProfile(sessionWithDraft(skipped), submission(skipped));
  assert.ok(profile.unknownTopics.some(t => t.topic === 'communication'));
  assert.equal(profile.unresolved.length, 1);
});
test('an informative clarification replaces the old interpretation without treating it as confirmed', () => {
  let draft = draftWithQuestion();
  draft = answerProfileQuestion(draft, { questionId: draft.questions[0].id, text: 'For clients I explain the reasoning.' });
  const result = applyProfileAnswer(draft, { resolved: true, additions: [], decisions: [{
    entryId: draft.entries[1].id, action: 'replace', text: 'Explains the reasoning in client messages.', scope: 'Client messages', quote: 'For clients I explain the reasoning.'
  }] });
  assert.equal(result.status, 'review'); assert.equal(result.retired[0].text, draft.entries[1].text);
  assert.equal(result.entries[1].status, 'tentative'); assert.equal(result.entries[1].origin, 'clarification');
  assert.equal(result.entries[1].evidence[0].quote, 'For clients I explain the reasoning.');
});
test('unresolved answers do not create facts; a bare yes cannot create a replacement', () => {
  let draft = draftWithQuestion(); draft = answerProfileQuestion(draft, { questionId: draft.questions[0].id, text: 'yes' });
  const undecided = applyProfileAnswer(draft, { resolved: false, decisions: [], additions: [] });
  assert.equal(undecided.questions[0].status, 'unresolved'); assert.equal(undecided.entries[1].included, false);
  assert.throws(() => applyProfileAnswer(draft, { resolved: true, additions: [], decisions: [{ entryId: draft.entries[1].id,
    action: 'replace', text: 'Runs an eight-person team.', scope: '', quote: 'yes' }] }), /informative/);
});
test('clarifications cannot modify unrelated entries, fabricate evidence or smuggle extra fields', () => {
  let draft = draftWithQuestion(); draft = answerProfileQuestion(draft, { questionId: draft.questions[0].id, text: 'Keep it as described.' });
  const value = { resolved: true, additions: [], decisions: [{ entryId: draft.entries[0].id, action: 'keep', text: '', scope: '', quote: 'Keep it as described.' }] };
  assert.throws(() => applyProfileAnswer(draft, value), /affected/);
  value.decisions[0].entryId = draft.entries[1].id; value.decisions[0].quote = 'Not said';
  assert.throws(() => applyProfileAnswer(draft, value), /exact quote/);
  value.secret = 'not accepted'; assert.throws(() => applyProfileAnswer(draft, value), /unexpected/);
});
test('a failed/abandoned clarification falls back visibly, without confirming its answer', () => {
  let draft = draftWithQuestion(); draft = answerProfileQuestion(draft, { questionId: draft.questions[0].id, text: 'Some new detail.' });
  const result = useProfileNotes(draft);
  assert.equal(result.status, 'review'); assert.equal(result.pendingAnswer, null);
  assert.equal(result.questions[0].answer.text, 'Some new detail.'); assert.equal(result.entries[1].included, false);
  assert.match(result.note, /not been treated as completed/);
});
test('confirmation requires current draft/version and explicit acknowledgement', () => {
  const draft = applyProfileAudit(createProfileDraft(sourceSession(), empty()), audit()), session = sessionWithDraft(draft);
  for (const change of [{ acknowledged: false }, { profileVersion: 99 }, { draftId: 'someone-else' }]) {
    assert.throws(() => confirmProfile(session, { ...submission(draft), ...change }));
  }
  assert.throws(() => confirmProfile(session, { ...submission(draft), entries: [] }));
  const value = submission(draft); value.entries[0].evidence = [{ quote: 'Forged' }];
  assert.throws(() => confirmProfile(session, value), /editable profile fields/);
});
test('review edits are labelled as participant changes rather than proven by original quotes', () => {
  const draft = applyProfileAudit(createProfileDraft(sourceSession(), empty()), audit());
  const body = submission(draft); body.entries[0].text = 'I review projects.';
  const profile = confirmProfile(sessionWithDraft(draft), body), item = profile.entries[0];
  assert.equal(item.origin, 'participant_edited'); assert.equal(item.wordingBeforeEdit, 'I coordinate projects.');
  assert.equal(item.status, 'confirmed'); assert.equal(item.evidence[0].quote, 'I coordinate projects.');
});
test('removed entries cannot be revived via a stale ID on later profile edits', () => {
  const draft = applyProfileAudit(createProfileDraft(sourceSession(), empty()), audit());
  const profile = confirmProfile(sessionWithDraft(draft), submission(draft, [draft.entries[0]]));
  const session = { ...sessionWithDraft(draft), profileVersion: 1, profile };
  assert.throws(() => confirmProfile(session, { ...submission(draft), profileVersion: 1 }), /not part/);
});
test('confirmed context excludes all source quotations and rejected text from ordinary prompts', () => {
  const draft = applyProfileAudit(createProfileDraft(sourceSession(), sample()), audit());
  draft.entries[1].text = 'REJECTED_STYLE';
  const session = sessionWithDraft(draft); session.profile = confirmProfile(session, submission(draft, [draft.entries[0], draft.entries[2]]));
  session.profileVersion = 1; session.sample.text = 'REJECTED_SAMPLE_DETAIL';
  const prompt = JSON.stringify(twinMessages(session, 'open'));
  assert.ok(!prompt.includes('REJECTED_STYLE')); assert.ok(!prompt.includes('REJECTED_SAMPLE_DETAIL'));
  assert.ok(!prompt.includes('sourceId')); assert.ok(prompt.includes('unknownTopics'));
  const suggestions = JSON.stringify(suggestionMessages(session));
  assert.ok(!suggestions.includes('REJECTED_SAMPLE_DETAIL')); assert.ok(!suggestions.includes('REJECTED_STYLE'));
  assert.ok(JSON.stringify(twinMessages(session, 'demo', '', { includeSample: true })).includes('REJECTED_SAMPLE_DETAIL'));
});
test('manual statements and contextual scopes survive the versioned handoff', () => {
  const draft = createProfileDraft({}, empty(), 'manual'), session = sessionWithDraft(draft);
  const body = submission(draft, []); body.entries = [{ id: '', topic: 'communication', text: 'I explain uncertainty.', scope: 'Client messages only' }];
  const profile = confirmProfile(session, body); session.profile = profile;
  assert.equal(profile.version, 1); assert.equal(profile.entries[0].origin, 'participant_edited');
  assert.equal(profileContext(session).statements[0].scope, 'Client messages only');
  assert.equal(profileContext(session).limited, true);
});
test('schema request shape is stable and output cannot invent profile-wide fields', () => {
  const draft = createProfileDraft(sourceSession(), empty());
  assert.throws(() => applyProfileAudit(draft, { ...audit(), profession: 'Pilot' }), /unexpected/);
  assert.throws(() => applyProfileAudit(draft, { ...audit(), sampleNotes: Array(5).fill({ text: '', scope: '', quote: '' }) }), /too many/);
});

test('profile builder uses one request normally and records separate cache metrics', async () => {
  const draft = createProfileDraft(sourceSession(), empty()); let calls = 0;
  const result = await advanceProfile({ async chat(messages, options) {
    calls++; assert.equal(options.maxOutputTokens, 2800);
    return { text: JSON.stringify(audit()), metrics: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40 } };
  } }, draft);
  assert.equal(calls, 1); assert.equal(result.draft.usage.attempts, 1); assert.equal(result.draft.usage.cacheReadTokens, 30);
});
test('invalid content gets one repair and rejected-response usage remains counted', async () => {
  const draft = createProfileDraft(sourceSession(), empty()); let calls = 0;
  const result = await advanceProfile({ async chat() { return { text: ++calls === 1 ? '{}' : JSON.stringify(audit()), metrics: { inputTokens: 10, outputTokens: 20 } }; } }, draft);
  assert.equal(result.draft.usage.repairs, 1); assert.equal(result.draft.usage.inputTokens, 20);
});
test('two invalid outputs fail without changing notes and manual retries are bounded', async () => {
  const draft = createProfileDraft(sourceSession(), empty()), original = structuredClone(draft.entries); let calls = 0;
  const model = { async chat() { calls++; return { text: 'bad' }; } };
  await assert.rejects(advanceProfile(model, draft)); assert.deepEqual(draft.entries, original); assert.equal(draft.status, 'building');
  await assert.rejects(advanceProfile(model, draft)); assert.equal(calls, 4); assert.equal(canRetryProfile(draft), false);
  await assert.rejects(advanceProfile(model, draft), /limit/); assert.equal(calls, 4);
});
test('provider errors are not retried; cancelled results cannot become a completed draft', async () => {
  const draft = createProfileDraft(sourceSession(), empty()); let calls = 0;
  await assert.rejects(advanceProfile({ async chat() { calls++; throw new Error('offline'); } }, draft), /offline/);
  assert.equal(calls, 1); assert.equal(draft.usage.unknownUsageRequests, 1);
  const controller = new AbortController();
  await assert.rejects(advanceProfile({ async chat() { controller.abort(); return { text: JSON.stringify(audit()) }; } }, draft, controller.signal));
  assert.equal(draft.status, 'building');
});
test('oversized prompts and session-wide attempt limits fail before billing', async () => {
  const draft = createProfileDraft(sourceSession(), empty()); let calls = 0;
  const model = { async chat() { calls++; return { text: JSON.stringify(audit()) }; } };
  draft.sample.text = 'x'.repeat(PROFILE_BUDGET.promptBytes);
  await assert.rejects(advanceProfile(model, draft), /budget/);
  draft.sample = empty(); draft.usage.attempts = PROFILE_BUDGET.attemptsTotal;
  await assert.rejects(advanceProfile(model, draft), /limit/); assert.equal(calls, 0);
});
test('clarification prompt only includes the relevant entries, not retired ones', () => {
  let draft = draftWithQuestion(); draft.retired.push({ text: 'PRIVATE_RETIRED' });
  draft = answerProfileQuestion(draft, { questionId: draft.questions[0].id, text: 'I explain client context.' });
  const prompt = JSON.stringify(profileAnswerMessages(draft));
  assert.ok(!prompt.includes('PRIVATE_RETIRED')); assert.ok(!prompt.includes('I coordinate projects.'));
  assert.ok(prompt.includes('I explain client context.'));
});

function problemSession() {
  const s = sourceSession(), message = { id: randomUUID(), role: 'user', kind: 'answer', text: 'Approvals take weeks and invoices pile up.' };
  s.interview.messages.push(message);
  const problem = (title, quote, status = 'tentative') => ({ id: randomUUID(), topic: 'friction', title, detail: `${title}.`,
    evidence: [{ sourceMessageId: message.id, quote }], status });
  s.interview.problems.push(problem('Chasing approvals', 'Approvals take weeks'), problem('Invented problem', 'not said'),
    problem('Withdrawn problem', 'invoices pile up', 'dropped'));
  return s;
}

test('interview problems seed the draft only with re-checked quotes; dropped ones stay out', () => {
  const draft = createProfileDraft(problemSession(), empty());
  assert.deepEqual(draft.problems.map(p => p.title), ['Chasing approvals']);
  assert.deepEqual(draft.problems[0].evidence[0].quote, 'Approvals take weeks');
  assert.equal(draft.problems[0].origin, 'interview');
  assert.deepEqual(createProfileDraft(problemSession(), empty(), 'manual').problems, []);
});

test('the participant keeps, rewords, removes or adds problems; none is fine and five is the limit', () => {
  const draft = applyProfileAudit(createProfileDraft(problemSession(), empty()), audit()), s = sessionWithDraft(draft);
  const [kept] = draft.problems, base = submission(draft);
  assert.deepEqual(confirmProfile(s, base).problems, []);
  let profile = confirmProfile(s, { ...base, problems: [{ id: kept.id, title: kept.title, detail: kept.detail }, { id: '', title: 'Weekly reports', detail: '' }] });
  assert.deepEqual(profile.problems.map(p => [p.title, p.origin, p.status, p.evidence.length]),
    [['Chasing approvals', 'interview', 'confirmed', 1], ['Weekly reports', 'participant', 'confirmed', 0]]);
  profile = confirmProfile(s, { ...base, problems: [{ id: kept.id, title: 'Waiting on sign-off', detail: '' }] });
  assert.equal(profile.problems[0].origin, 'participant_edited');
  const many = Array.from({ length: 6 }, (_, i) => ({ id: '', title: `Problem ${i}`, detail: '' }));
  for (const problems of [many, [{ id: randomUUID(), title: 'Unknown ID', detail: '' }], [{ id: '', title: 'Same', detail: '' }, { id: '', title: 'same', detail: '' }],
    [{ id: '', title: '', detail: '' }], [{ id: '', title: 'Extra field', detail: '', evidence: [] }]]) {
    assert.throws(() => confirmProfile(s, { ...base, problems }));
  }
  const context = profileContext({ ...s, profile: confirmProfile(s, { ...base, problems: [{ id: kept.id, title: kept.title, detail: kept.detail }] }) });
  assert.deepEqual(context.problems, [{ id: kept.id, title: 'Chasing approvals', detail: 'Chasing approvals.' }]);
  assert.doesNotMatch(JSON.stringify(context), /Approvals take weeks/);
});
