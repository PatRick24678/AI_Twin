import { randomUUID } from 'node:crypto';
import { INTERVIEW_TOPICS } from './interview-contract.mjs';
import { workingProfile } from './interview-state.mjs';
import { requireThat, text, EXAMPLES } from './domain.mjs';

export const PROFILE_TOPICS = Object.freeze({ ...INTERVIEW_TOPICS, other: 'Other information you provided' });
export const PROFILE_LIMITS = Object.freeze({ entries: 112, statement: 240, scope: 180, totalText: 16000, clarifications: 2, answer: 1200 });
const norm = value => value.replace(/\s+/g, ' ').trim();
const same = value => norm(value).toLowerCase();
export class ProfileOutputError extends Error {}
const check = (condition, message) => { if (!condition) throw new ProfileOutputError(message); };
const str = maxLength => ({ type: 'string', maxLength });
const obj = properties => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
const arr = (items, maxItems) => ({ type: 'array', maxItems, items });
const topicSchema = { type: 'string', enum: Object.keys(PROFILE_TOPICS) };
const citation = { quote: str(600) };
export const PROFILE_AUDIT_SCHEMA = obj({
  sampleNotes: arr(obj({ text: str(240), scope: str(180), ...citation }), 4),
  clarifications: arr(obj({ topic: topicSchema, question: str(320), reason: str(200), entryIds: arr(str(60), 6), usesSample: { type: 'boolean' } }), 2)
});
export const PROFILE_ANSWER_SCHEMA = obj({
  resolved: { type: 'boolean' },
  decisions: arr(obj({ entryId: str(60), action: { type: 'string', enum: ['keep', 'replace', 'remove'] }, text: str(240), scope: str(180), ...citation }), 10),
  additions: arr(obj({ topic: topicSchema, text: str(240), scope: str(180), ...citation }), 4)
});
// The limited JSON Schema subset used here. This is not a general schema engine.
export function validateProfileOutput(value, schema) {
  function visit(item, spec, path) {
    if (spec.type === 'object') {
      check(item && typeof item === 'object' && !Array.isArray(item), `${path} must be an object.`);
      const keys = Object.keys(spec.properties);
      check(Object.keys(item).length === keys.length && keys.every(key => Object.hasOwn(item, key)), `${path} has missing or unexpected fields.`);
      keys.forEach(key => visit(item[key], spec.properties[key], `${path}.${key}`));
    } else if (spec.type === 'array') {
      check(Array.isArray(item) && item.length <= spec.maxItems, `${path} has too many items.`);
      item.forEach((child, i) => visit(child, spec.items, `${path}[${i}]`));
    } else if (spec.type === 'boolean') check(typeof item === 'boolean', `${path} must be boolean.`);
    else {
      check(typeof item === 'string' && (spec.maxLength === undefined || item.length <= spec.maxLength), `${path} must be bounded text.`);
      check(!spec.enum || spec.enum.includes(item), `${path} has an invalid value.`);
    }
  }
  visit(value, schema, 'result');
}
function entry(topic, statement, scope, origin, evidence) {
  return { id: randomUUID(), topic, text: statement, scope, origin, evidence, status: 'tentative', included: true };
}
function markReview(draft) {
  draft.status = 'review'; draft.requestId = null; draft.pendingAnswer = null;
  return draft;
}
function nextQuestion(draft) {
  draft.requestId = null; draft.pendingAnswer = null;
  draft.status = draft.questions.some(q => q.status === 'pending') ? 'clarifying' : 'review';
  return draft;
}
export function currentProfileQuestion(draft) { return draft?.questions.find(q => q.status === 'pending') || null; }

export function createProfileDraft(session, sample, mode = 'build') {
  const draft = {
    id: randomUUID(), requestId: randomUUID(), status: 'building', entries: [], questions: [], retired: [], pendingAnswer: null,
    sample: structuredClone(sample), blockedTopics: [], allowQuestions: session.interview?.finishReason !== 'participant',
    note: '', usage: { attempts: 0, repairs: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, unknownUsageRequests: 0, perRequest: {} }
  };
  if (session.interview) {
    draft.blockedTopics = Object.entries(session.interview.topics)
      .filter(([, value]) => ['skipped', 'declined', 'not_applicable', 'unclear'].includes(value.status)).map(([id]) => id);
    if (mode !== 'manual') for (const note of workingProfile(session.interview).observations) {
      const source = session.interview.messages.find(message => message.id === note.sourceMessageId);
      // Re-check original provenance. Do not seed notes from questions, withdrawn notes or a missing quote.
      if (source?.role !== 'user' || source.kind !== 'answer' || typeof note.quote !== 'string' || !norm(note.quote) || !norm(source.text).includes(norm(note.quote))) continue;
      const evidence = { sourceId: source.id, kind: 'interview', label: INTERVIEW_TOPICS[note.topic], quote: note.quote };
      const duplicate = draft.entries.find(item => item.topic === note.topic && same(item.text) === same(note.statement));
      if (duplicate) {
        if (!duplicate.evidence.some(e => e.sourceId === source.id && e.quote === note.quote)) duplicate.evidence.push(evidence);
      } else draft.entries.push(entry(note.topic, note.statement, '', 'interview', [evidence]));
    }
  }
  const chosen = EXAMPLES.find(example => example.id === sample.style);
  if (chosen && mode !== 'manual') draft.entries.push(entry('communication',
    `For this exercise, I chose the ${chosen.label.toLowerCase()} writing example.`, 'An exercise preference, not a personality type.',
    'exercise_choice', [{ sourceId: 'style_choice', kind: 'choice', label: 'Your explicit selection', quote: chosen.label }]));
  if (mode === 'manual') { draft.note = 'You are writing this profile yourself. No AI interpretation is being approved automatically.'; return markReview(draft); }
  if (!draft.entries.length && !(sample.text && sample.authored && sample.typical)) {
    draft.note = 'No personal observations are available. A borrowed or non-typical sample can be used for a draft, but does not establish your work or style.';
    return markReview(draft);
  }
  return draft;
}

export function applyProfileAudit(draft, output) {
  validateProfileOutput(output, PROFILE_AUDIT_SCHEMA);
  check(draft.status === 'building', 'The profile audit is not pending.');
  const next = structuredClone(draft), sample = next.sample;
  check(!output.sampleNotes.length || (sample.text && sample.authored && sample.typical && !next.blockedTopics.includes('communication')),
    'Only a typical self-authored sample can support contextual writing observations, unless the topic was declined.');
  for (const item of output.sampleNotes) {
    check(item.text.trim() && item.scope.trim() && norm(item.quote) && norm(sample.text).includes(norm(item.quote)), 'Sample observations need a scope and an exact quote from the sample.');
    check(!next.entries.some(e => e.topic === 'communication' && same(e.text) === same(item.text)), 'Do not duplicate a writing observation.');
    next.entries.push(entry('communication', item.text.trim(), item.scope.trim(), 'sample', [{ sourceId: 'sample', kind: 'sample', label: sample.context, quote: item.quote.trim() }]));
  }
  const addressed = new Set(), questions = new Set();
  for (const item of output.clarifications) {
    check(next.allowQuestions, 'The participant asked to stop: do not add clarification questions.');
    check(!next.blockedTopics.includes(item.topic), 'Do not reopen a skipped, declined or exhausted topic.');
    check(item.question.trim() && item.reason.trim(), 'A clarification must have a question and a specific reason.');
    check(new Set(item.entryIds).size === item.entryIds.length && item.entryIds.every(id => draft.entries.some(e => e.id === id)), 'Use current interview/exercise entry IDs, not invented or sample-note IDs.');
    check(item.entryIds.every(id => !next.blockedTopics.includes(draft.entries.find(e => e.id === id).topic)), 'Do not probe a blocked entry under a different topic.');
    check(!(item.usesSample && next.blockedTopics.includes('communication')), 'Do not reopen declined sample/style analysis.');
    check(item.entryIds.length > 0 || (item.usesSample && sample.text), 'A clarification must reference existing evidence.');
    check(!item.usesSample || !next.questions.some(q => q.usesSample), 'Ask at most one question about the sample.');
    check(!item.usesSample || Boolean(sample.text), 'A clarification refers to a sample that does not exist.');
    check(!item.entryIds.some(id => addressed.has(id)), 'Do not question the same entry twice.');
    check(!questions.has(same(item.question)), 'Do not repeat a clarification.');
    item.entryIds.forEach(id => addressed.add(id)); questions.add(same(item.question));
    const q = { id: randomUUID(), ...item, status: 'pending' };
    // New sample interpretations implicated in a sample question also need a review decision.
    q.relatedIds = [...item.entryIds, ...(item.usesSample ? next.entries.filter(e => e.origin === 'sample').map(e => e.id) : [])];
    next.questions.push(q);
    for (const id of q.relatedIds) {
      const candidate = next.entries.find(e => e.id === id);
      candidate.status = 'needs_review'; candidate.included = false;
    }
  }
  check(next.entries.length <= PROFILE_LIMITS.entries, 'Too many profile observations.');
  return nextQuestion(next);
}

export function answerProfileQuestion(draft, { questionId, kind = 'answer', text: value = '' }) {
  requireThat(draft?.status === 'clarifying', 'There is no clarification waiting.', 409);
  const q = currentProfileQuestion(draft);
  requireThat(q && q.id === questionId, 'This clarification belongs to an old or different profile.', 409);
  requireThat(['answer', 'skip', 'stop'].includes(kind), 'Choose answer or skip.');
  const next = structuredClone(draft), target = currentProfileQuestion(next);
  if (kind !== 'answer') {
    target.status = 'skipped';
    if (kind === 'stop') next.questions.filter(item => item.status === 'pending').forEach(item => { item.status = 'skipped'; });
    return nextQuestion(next);
  }
  const answer = text(value, 'Clarification answer', PROFILE_LIMITS.answer, 1);
  next.pendingAnswer = { id: randomUUID(), questionId, text: answer };
  next.status = 'resolving'; next.requestId = randomUUID();
  return next;
}

export function applyProfileAnswer(draft, output) {
  validateProfileOutput(output, PROFILE_ANSWER_SCHEMA);
  check(draft.status === 'resolving' && draft.pendingAnswer, 'There is no answer to interpret.');
  const next = structuredClone(draft), q = currentProfileQuestion(next), answer = next.pendingAnswer;
  const ref = quote => {
    check(norm(quote) && norm(answer.text).includes(norm(quote)), 'A decision needs an exact quote from the clarification answer.');
    return { sourceId: answer.id, kind: 'clarification', label: q.question, quote: quote.trim() };
  };
  if (!output.resolved) {
    check(!output.decisions.length && !output.additions.length, 'An unresolved answer must not silently settle profile facts.');
    q.status = 'unresolved'; q.answer = answer;
    return nextQuestion(next);
  }
  const ids = output.decisions.map(item => item.entryId);
  const affected = q.relatedIds.filter(id => next.entries.some(e => e.id === id));
  check(ids.length === affected.length && new Set(ids).size === ids.length && ids.every(id => affected.includes(id)),
    'Decide once on every affected current entry, and no other entries.');
  for (const item of output.decisions) {
    const evidence = ref(item.quote), old = next.entries.find(e => e.id === item.entryId);
    if (item.action === 'replace') {
      check(item.text.trim() && !/^(?:yes|yeah|okay|ok|sure)[.!\s]*$/i.test(answer.text), 'A replacement requires an informative answer and text.');
      next.retired.push({ ...old, status: 'superseded' });
      old.text = item.text.trim(); old.scope = item.scope.trim(); old.origin = 'clarification'; old.evidence = [evidence];
    } else check(item.text === '' && item.scope === '', 'Keep/remove decisions must not rewrite the observation.');
    if (item.action === 'remove') {
      next.retired.push({ ...old, status: 'retracted' }); next.entries = next.entries.filter(e => e.id !== old.id);
    } else {
      if (item.action === 'keep') old.evidence.push(evidence);
      old.status = 'tentative'; old.included = true;
    }
  }
  for (const item of output.additions) {
    check(item.topic === q.topic && !next.blockedTopics.includes(item.topic), 'Clarification additions must stay on the allowed question topic.');
    check(item.text.trim() && !/^(?:yes|yeah|okay|ok|sure)[.!\s]*$/i.test(answer.text), 'New observations require an informative answer.');
    check(!next.entries.some(e => e.topic === item.topic && same(e.text) === same(item.text)), 'Do not duplicate a current observation.');
    next.entries.push(entry(item.topic, item.text.trim(), item.scope.trim(), 'clarification', [ref(item.quote)]));
  }
  check(next.entries.length <= PROFILE_LIMITS.entries, 'Too many profile entries.');
  q.status = 'answered'; q.answer = answer;
  return nextQuestion(next);
}

export function useProfileNotes(draft) {
  const next = structuredClone(draft);
  if (next.pendingAnswer) {
    const q = currentProfileQuestion(next); q.answer = next.pendingAnswer; q.status = 'unresolved';
  }
  next.questions.filter(q => q.status === 'pending').forEach(q => { q.status = 'skipped'; });
  next.note = 'Continuing with the available notes. The failed or skipped analysis has not been treated as completed.';
  return markReview(next);
}

export function confirmProfile(session, body) {
  requireThat(body.profileVersion === session.profileVersion, 'The profile version changed. Reload its current state.', 409);
  requireThat(body.acknowledged === true, 'Confirm that you checked the included statements.');
  const editing = Boolean(session.profile), source = editing ? session.profile : session.profileDraft;
  requireThat(editing || (source?.status === 'review' && body.draftId === source.id), 'Open the current completed profile draft first.', 409);
  requireThat(Array.isArray(body.entries) && body.entries.length >= 1 && body.entries.length <= PROFILE_LIMITS.entries,
    'Include at least one statement, or add information before creating a personal twin.');
  const seen = new Set();
  let total = 0;
  const entries = body.entries.map(value => {
    requireThat(value && typeof value === 'object', 'Invalid profile entry.');
    requireThat(Object.keys(value).every(key => ['id', 'topic', 'text', 'scope'].includes(key)), 'Send editable profile fields only, not evidence or confirmation metadata.');
    requireThat(typeof value.id === 'string' && value.id.length <= 60, 'Invalid profile entry ID.');
    requireThat(Object.hasOwn(PROFILE_TOPICS, value.topic), 'Choose a supported profile category.');
    const statement = text(value.text, 'Profile statement', PROFILE_LIMITS.statement, 1);
    const scope = text(value.scope, 'Statement context', PROFILE_LIMITS.scope);
    const old = value.id ? source.entries.find(item => item.id === value.id) : null;
    requireThat(!value.id || old, 'That entry is not part of your current profile.', 409);
    requireThat(!value.id || !seen.has(value.id), 'Duplicate profile entry ID.');
    seen.add(value.id || randomUUID()); total += statement.length + scope.length;
    const edited = !old || old.text !== statement || old.scope !== scope || old.topic !== value.topic;
    return { id: old?.id || randomUUID(), topic: value.topic, text: statement, scope,
      origin: edited ? 'participant_edited' : old.origin, status: 'confirmed',
      // Edits remain distinguishable from the evidence-backed wording before approval.
      evidence: old ? structuredClone(old.evidence) : [],
      ...(edited && old ? { wordingBeforeEdit: old.text } : old?.wordingBeforeEdit ? { wordingBeforeEdit: old.wordingBeforeEdit } : {}) };
  });
  requireThat(total <= PROFILE_LIMITS.totalText, 'The confirmed profile is too large for this demonstrator; shorten the statements.');
  const duplicateKeys = entries.map(e => `${e.topic}:${same(e.text)}:${same(e.scope)}`);
  requireThat(new Set(duplicateKeys).size === entries.length, 'Remove duplicate profile statements.');
  const sourceQuestions = session.profileDraft?.questions || [];
  const unresolved = sourceQuestions.filter(q => ['unresolved', 'skipped'].includes(q.status)).map(q => ({
    topic: q.topic, question: q.question, status: q.status,
    relatedEntryIds: q.relatedIds.filter(id => entries.some(e => e.id === id))
  }));
  return { schemaVersion: 2, version: session.profileVersion + 1, entries,
    unknownTopics: Object.entries(INTERVIEW_TOPICS).filter(([id]) => !entries.some(e => e.topic === id))
      .map(([topic, label]) => ({ topic, label })), unresolved,
    limited: !['role', 'workflow', 'communication', 'retain'].every(topic => entries.some(e => e.topic === topic)) };
}

// Neither raw interview answers nor retired claims are necessary for normal twin inference.
export function profileContext(session) {
  const profile = session.profile;
  if (!profile) return { version: session.profileVersion, statements: (session.facts || []).map((text, i) => ({ id: `fact-${i + 1}`, text })), unknownTopics: [], unresolved: [], limited: true };
  return { version: profile.version,
    statements: profile.entries.map(({ id, topic, text, scope }) => ({ id, topic, text, scope })),
    unknownTopics: profile.unknownTopics.map(item => item.topic),
    // Topic/status only: a skipped question's wording may contain a rejected assumption.
    unresolved: profile.unresolved.map(({ topic, status }) => ({ topic, status })), limited: profile.limited };
}
