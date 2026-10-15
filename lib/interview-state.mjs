import { randomUUID } from 'node:crypto';
import {
  INTERVIEW_TOPICS, INTERVIEW_LIMITS, assertInterview, validateInterviewTurn
} from './interview-contract.mjs';

const CORE = ['role', 'workflow', 'friction', 'communication', 'retain'];
const BLOCKED = new Set(['skipped', 'declined', 'not_applicable', 'unclear']);
const normalize = text => text.replace(/\s+/g, ' ').trim();
const questionKey = text => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const acknowledgementOnly = text => /^(?:yes|yeah|yep|ok|okay|sure|right|fine|thanks)[.!\s]*$/i.test(text.trim());

export function createInterview() {
  return {
    id: randomUUID(), revision: 0, status: 'thinking', requestId: randomUUID(),
    turns: 0, emptyTurns: 0, finishReason: null,
    activeQuestion: null, pendingInput: null,
    messages: [], questions: [], observations: [],
    topics: Object.fromEntries(Object.keys(INTERVIEW_TOPICS).map(id => [id, {
      asked: 0, misses: 0, status: 'open', boundaryEvidence: null
    }]))
  };
}

function activeObservations(state) {
  return state.observations.filter(note => note.status === 'tentative');
}

export function availableTopics(state) {
  if (state.status === 'complete' || state.turns >= INTERVIEW_LIMITS.turns) return [];
  return Object.keys(INTERVIEW_TOPICS).filter(id => {
    const topic = state.topics[id];
    return !BLOCKED.has(topic.status) && topic.asked < INTERVIEW_LIMITS.questionsPerTopic;
  });
}

function finish(state, reason) {
  state.status = 'complete';
  state.finishReason = reason;
  state.activeQuestion = null;
  state.pendingInput = null;
  state.requestId = null;
  state.messages.push({
    id: randomUUID(), role: 'assistant', kind: 'closing',
    text: 'Thank you. We can work with what you have shared and leave the remaining details unknown.'
  });
  return state;
}

// Explicit UI actions are trusted intent, not model-generated profile evidence.
// "stop" is available to the controller; it does not require a new visible button.
export function recordInterviewInput(state, { kind = 'answer', text = '' } = {}) {
  assertInterview(['answer', 'skip', 'stop'].includes(kind), 'Unknown interview input.');
  assertInterview(state.status !== 'complete', 'The interview has ended.');
  assertInterview(kind === 'stop' || state.status === 'waiting', 'Wait for the current question.');
  assertInterview(typeof text === 'string', 'The answer must be text.');
  text = text.trim();
  if (kind === 'answer') {
    assertInterview(text.length > 0, 'Enter an answer or skip the question.');
    assertInterview(text.length <= INTERVIEW_LIMITS.answerCharacters, 'The answer is too long.');
  } else {
    assertInterview(text === '', 'Control actions must not contain answer text.');
  }

  const next = structuredClone(state);
  next.revision += 1;
  if (kind === 'stop') return finish(next, 'participant');

  const input = {
    id: randomUUID(), role: 'user', kind, text,
    questionId: next.activeQuestion.id
  };
  next.messages.push(input);
  next.pendingInput = input.id;
  next.turns += 1;
  next.status = 'thinking';
  next.requestId = randomUUID();

  if (kind === 'skip') {
    // Conservatively pause this narrow focus for the remainder of the interview.
    // Other focuses remain available; skip is not a personality observation.
    next.topics[next.activeQuestion.topic].status = 'skipped';
    next.emptyTurns += 1;
  }
  return next;
}

export function applyInterviewTurn(state, requestId, output) {
  assertInterview(
    state.status === 'thinking' && requestId === state.requestId,
    'Stale or unexpected interview response.'
  );
  validateInterviewTurn(output);

  // All work happens on a copy. Invalid replies cannot partially change the state.
  const next = structuredClone(state);
  const input = next.messages.find(message => message.id === next.pendingInput);

  function evidence(item) {
    assertInterview(
      input?.kind === 'answer' && item.sourceMessageId === input.id,
      'Evidence must reference the current participant answer.'
    );
    assertInterview(
      normalize(item.quote).length > 0 && normalize(input.text).includes(normalize(item.quote)),
      'The supporting quote is not in that answer.'
    );
    return { sourceMessageId: input.id, quote: item.quote.trim() };
  }

  const changed = new Set();
  const boundaryTopics = new Set();
  for (const item of output.boundaries) {
    const source = evidence(item);
    assertInterview(!boundaryTopics.has(item.topic), 'Duplicate topic boundary.');
    boundaryTopics.add(item.topic);
    next.topics[item.topic].status = item.reason;
    next.topics[item.topic].boundaryEvidence = source;
  }

  for (const item of output.retractions) {
    const source = evidence(item);
    const old = next.observations.find(note => note.id === item.observationId);
    assertInterview(old?.status === 'tentative', 'Only an active observation can be retracted.');
    old.status = 'retracted';
    old.retiredBy = source;
    changed.add(old.topic);
  }

  for (const item of output.observations) {
    const source = evidence(item);
    assertInterview(!acknowledgementOnly(input.text), 'An acknowledgement alone cannot establish new profile details.');
    assertInterview(!boundaryTopics.has(item.topic), 'A declined topic must not create a new observation in the same turn.');
    assertInterview(item.statement.trim().length > 0, 'An observation cannot be empty.');

    let old;
    if (item.replacesId) {
      old = next.observations.find(note => note.id === item.replacesId);
      assertInterview(
        old?.status === 'tentative' && old.topic === item.topic,
        'A replacement must target an active observation in the same topic.'
      );
    }
    const duplicate = activeObservations(next).some(note =>
      note.id !== old?.id && note.topic === item.topic &&
      questionKey(note.statement) === questionKey(item.statement)
    );
    assertInterview(!duplicate, 'Do not repeat an existing observation.');

    const note = {
      id: randomUUID(), topic: item.topic, statement: item.statement.trim(),
      ...source, status: 'tentative'
    };
    if (old) { old.status = 'superseded'; old.replacedBy = note.id; }
    next.observations.push(note);
    changed.add(item.topic);
  }

  for (const id of changed) {
    if (!BLOCKED.has(next.topics[id].status)) {
      next.topics[id].status = activeObservations(next).some(note => note.topic === id)
        ? 'covered' : 'open';
    }
  }

  if (input?.kind === 'answer') {
    const topic = next.topics[next.activeQuestion.topic];
    const hasNewInformation = changed.has(next.activeQuestion.topic);
    if (!BLOCKED.has(topic.status)) {
      topic.misses = hasNewInformation ? 0 : topic.misses + 1;
      if (topic.misses >= INTERVIEW_LIMITS.unsuccessfulAnswersPerTopic) topic.status = 'unclear';
    }
    next.emptyTurns = changed.size ? 0 : next.emptyTurns + 1;
  }

  next.revision += 1;
  if (output.stopQuote) {
    evidence({ sourceMessageId: input?.id, quote: output.stopQuote });
    return finish(next, 'participant');
  }
  if (next.turns >= INTERVIEW_LIMITS.turns) return finish(next, 'turn_limit');

  const allowed = availableTopics(next);
  const coreAddressed = CORE.every(id =>
    activeObservations(next).some(note => note.topic === id) ||
    BLOCKED.has(next.topics[id].status) ||
    next.topics[id].asked >= INTERVIEW_LIMITS.questionsPerTopic
  );

  if (!allowed.length) return finish(next, 'topics_exhausted');
  if (output.question.topic === 'none') {
    assertInterview(
      output.question.text === '' && output.question.gap === '',
      'A closing turn must not contain another question.'
    );
    assertInterview(coreAddressed || next.emptyTurns >= 3, 'The interviewer tried to finish before useful coverage.');
    return finish(next, coreAddressed ? 'coverage' : 'limited_context');
  }

  const question = output.question;
  assertInterview(allowed.includes(question.topic), 'This question topic is blocked or exhausted.');
  assertInterview(question.text.trim().length > 0, 'Provide a question.');
  assertInterview(
    !next.questions.some(previous => questionKey(previous.text) === questionKey(question.text)),
    'This question has already been asked.'
  );
  if (next.topics[question.topic].asked > 0) {
    assertInterview(question.gap.trim().length > 0, 'A follow-up must name the unresolved gap.');
  }

  const saved = { id: randomUUID(), ...question };
  next.questions.push(saved);
  next.activeQuestion = saved;
  next.topics[question.topic].asked += 1;
  next.messages.push({
    id: randomUUID(), role: 'assistant', kind: 'question', questionId: saved.id,
    text: [output.acknowledgement.trim(), question.text.trim()].filter(Boolean).join('\n\n')
  });
  next.status = 'waiting';
  next.pendingInput = null;
  next.requestId = null;
  return next;
}

// Internal handoff for a later profile builder, NOT a final review-screen design.
export function workingProfile(state) {
  const observations = activeObservations(state).map(note => structuredClone(note));
  return {
    observations,
    unknownTopics: Object.keys(INTERVIEW_TOPICS)
      .filter(id => !observations.some(note => note.topic === id))
      .map(id => ({ topic: id, label: INTERVIEW_TOPICS[id] })),
    finishReason: state.finishReason
  };
}