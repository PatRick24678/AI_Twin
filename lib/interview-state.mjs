import { randomUUID } from 'node:crypto';
import {
  INTERVIEW_TOPICS, INTERVIEW_AGENDA, INTERVIEW_LIMITS, assertInterview, validateInterviewTurn
} from './interview-contract.mjs';

const CORE = ['role', 'workflow', 'friction', 'communication', 'retain'];
const BLOCKED = new Set(['skipped', 'declined', 'not_applicable', 'unclear']);
const normalize = text => text.replace(/\s+/g, ' ').trim();
const questionKey = text => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const acknowledgementOnly = text => /^(?:yes|yeah|yep|ok|okay|sure|right|fine|thanks)[.!\s]*$/i.test(text.trim());

export function createInterview() {
  return {
    id: randomUUID(), revision: 0, status: 'thinking', requestId: randomUUID(),
    turns: 0, emptyTurns: 0, followUpStreak: 0, finishReason: null,
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

// Areas not asked about yet, in the interviewer's priority order.
export function unexploredAgenda(state) {
  const allowed = availableTopics(state);
  return INTERVIEW_AGENDA.filter(id => allowed.includes(id) && state.topics[id].asked === 0);
}

// After a skip, or after one follow-up, the interviewer must open a new area (if any remain).
export function mustChangeSubject(state) {
  const input = state.messages.find(message => message.id === state.pendingInput);
  return input?.kind === 'skip' || state.followUpStreak >= 1;
}

function coreAddressed(state) {
  return CORE.every(id => activeObservations(state).some(note => note.topic === id) ||
    BLOCKED.has(state.topics[id].status) || state.topics[id].asked >= INTERVIEW_LIMITS.questionsPerTopic);
}

// Where the NEXT question falls. The model signposts with this; the controller enforces the last question.
export function interviewPace(state) {
  const questionNumber = state.questions.length + 1, core = coreAddressed(state);
  const lastRequired = (core && questionNumber >= INTERVIEW_LIMITS.targetTurns) ||
    questionNumber >= Math.min(INTERVIEW_LIMITS.latestLastQuestion, INTERVIEW_LIMITS.turns);
  return { questionNumber, targetQuestions: INTERVIEW_LIMITS.targetTurns,
    pace: questionNumber < INTERVIEW_LIMITS.targetTurns - 1 ? 'exploring' : 'wrapping_up',
    lastAllowed: lastRequired || (core && questionNumber >= INTERVIEW_LIMITS.targetTurns - 1), lastRequired };
}

function finish(state, reason, closing = '') {
  state.status = 'complete';
  state.finishReason = reason;
  state.activeQuestion = null;
  state.pendingInput = null;
  state.requestId = null;
  state.messages.push({
    id: randomUUID(), role: 'assistant', kind: 'closing',
    text: closing.trim() || 'Thank you. We can work with what you have shared and leave the remaining details unknown.'
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
  // A skip has no text, so nothing in it can be evidence. The controller already pauses its topic:
  // ignore stray notes/boundaries/retractions/stop signals instead of failing the whole turn.
  if (input?.kind === 'skip') output = { ...output, observations: [], boundaries: [], retractions: [], stopQuote: '' };

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
  const covered = coreAddressed(next);
  // The signposted last question has been answered or skipped: close with the model's words, ignore any question.
  if (next.activeQuestion?.last) return finish(next, covered ? 'coverage' : 'limited_context', output.acknowledgement);
  if (next.turns >= INTERVIEW_LIMITS.turns) return finish(next, 'turn_limit');

  const allowed = availableTopics(next), pace = interviewPace(next);
  if (!allowed.length) return finish(next, 'topics_exhausted');
  if (output.question.topic === 'none') {
    assertInterview(
      output.question.text === '' && output.question.gap === '',
      'A closing turn must not contain another question.'
    );
    assertInterview(next.emptyTurns >= 3,
      'Do not end abruptly. Ask a question; when pace.lastAllowed is true, set question.last to true and signpost it as the last one.');
    return finish(next, covered ? 'coverage' : 'limited_context');
  }

  const question = output.question;
  assertInterview(allowed.includes(question.topic), 'This question topic is blocked or exhausted.');
  // The interviewer leads: a skip or one follow-up means opening a new area. Relaxed once none remain.
  const unexplored = unexploredAgenda(next), options = `Choose one of: ${unexplored.join(', ')}.`;
  if (unexplored.length) {
    assertInterview(question.move === 'follow_up' || unexplored.includes(question.topic),
      `A new_area question must open a topic you have not asked about yet. ${options}`);
    assertInterview(question.move === 'new_area' || !mustChangeSubject(next), input?.kind === 'skip'
      ? `After a skip, change the subject: set move to new_area. ${options}`
      : `You already asked one follow-up; change the subject: set move to new_area. ${options}`);
  }
  assertInterview(question.text.trim().length > 0, 'Provide a question.');
  assertInterview(
    !next.questions.some(previous => questionKey(previous.text) === questionKey(question.text)),
    'This question has already been asked.'
  );
  if (next.topics[question.topic].asked > 0) {
    assertInterview(question.gap.trim().length > 0, 'A follow-up must name the unresolved gap.');
  }

  // Corrected, not rejected: the controller owns when the last question comes.
  const saved = { id: randomUUID(), ...question, last: pace.lastRequired || (question.last && pace.lastAllowed) };
  next.questions.push(saved);
  next.activeQuestion = saved;
  next.followUpStreak = question.move === 'follow_up' ? next.followUpStreak + 1 : 0;
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