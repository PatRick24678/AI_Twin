import { workingProfile } from './interview-state.mjs';
import { INTERVIEW_TOPICS } from './interview-contract.mjs';

export class AppError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export function requireThat(condition, message, status = 400) {
  if (!condition) throw new AppError(status, message);
}
export function text(value, label, max, min = 0) {
  requireThat(typeof value === 'string', `${label} must be text.`);
  const cleaned = value.trim();
  requireThat(cleaned.length >= min && cleaned.length <= max,
    `${label} must contain ${min}–${max} characters.`);
  return cleaned;
}
// Authored fictional examples, NOT real people or validated personality categories.
export const EXAMPLES = [
  { id: 'direct', label: 'Decision first',
    sample: 'Decision needed: move the review to Thursday. The draft is ready; the figures still need checking.' },
  { id: 'context', label: 'Context first',
    sample: 'The draft is ready, but we still need to check the figures. Moving the review to Thursday would give us time to do that.' },
  { id: 'collaborative', label: 'Discussion first',
    sample: 'The draft is ready. Could we check the figures together before the review? Would Thursday work for everyone?' }
];
export function sampleInput(body) {
  const sample = {
    text: text(body.text, 'Sample', 1600),
    context: text(body.context, 'Sample context', 180),
    authored: body.authored === true,
    typical: body.typical === true,
    style: body.style || 'none'
  };
  requireThat(sample.style === 'none' || EXAMPLES.some(e => e.id === sample.style),
    'Choose a listed writing example, or none.');
  requireThat(!sample.text || sample.context, 'Explain the sample’s audience or purpose.');
  return sample;
}
export function sourcesFor(session) {
  // Diagnostic evidence view; full interview messages are not re-extracted into profiles.
  const sources = session.interview
    ? workingProfile(session.interview).observations.map(note => ({
        id: note.id, label: INTERVIEW_TOPICS[note.topic], text: note.quote,
        interpretation: note.statement, sourceMessageId: note.sourceMessageId
      }))
    : session.answers.map((answer, i) => ({
        id: `answer${i + 1}`, label: `Legacy intake answer ${i + 1}`, text: answer
      }));
  const sample = session.sample;
  if (sample?.text && sample.authored && sample.typical) {
    sources.push({ id: 'sample', label: 'Your typical, self-authored sample', text: sample.text });
  }
  const example = EXAMPLES.find(e => e.id === sample?.style);
  if (example) sources.push({ id: 'style_choice', label: 'Your explicit example preference',
    text: `For this exercise, I prefer the ${example.label.toLowerCase()} writing example.` });
  return sources;
}
export const ACTIONS = {
  open: 'Open the future-self scene now. Use one recognisable task, one plausible change and one short invitation.',
  demo: 'Show me a small draft based on my work sample. If none was supplied, ask me for a fictional task example first.',
  unchanged: 'What would you keep doing yourself, and why?',
  challenge: 'I am not convinced. What might be inconvenient or worse about working this way?'
};
export function publicSession(s) {
  const draft = s.profileDraft;
  const profileDraft = draft ? {
    id: draft.id, status: draft.status, requestId: draft.requestId, entries: draft.entries,
    questions: draft.questions, pendingAnswer: draft.pendingAnswer, note: draft.note,
    retryAllowed: s.profileRetryAllowed, usage: Object.fromEntries(Object.entries(draft.usage).filter(([key]) => key !== 'perRequest'))
  } : null;
  return {
    name: s.name, stage: s.stage, intake: s.intake, claims: s.claims,
    facts: s.facts, profile: s.profile, profileDraft, messages: s.messages, reflection: s.reflection,
    metrics: s.metrics, notice: s.notice,
    profileVersion: s.profileVersion, suggestions: s.suggestions,
    suggestionStatus: s.suggestionStatus,
    interview: s.interview ? {
      status: s.interview.status,
      questionId: s.interview.activeQuestion?.id || null,
      requestId: s.interview.requestId,
      turns: s.interview.turns,
      finishReason: s.interview.finishReason,
      observationCount: workingProfile(s.interview).observations.length,
      retryAllowed: s.interviewRetryAllowed,
      usage: s.interviewUsage ? {
        attempts: s.interviewUsage.attempts, repairs: s.interviewUsage.repairs,
        inputTokens: s.interviewUsage.inputTokens, outputTokens: s.interviewUsage.outputTokens,
        cacheReadTokens: s.interviewUsage.cacheReadTokens,
        cacheWriteTokens: s.interviewUsage.cacheWriteTokens,
        unknownUsageRequests: s.interviewUsage.unknownUsageRequests
      } : null
    } : null
  };
}
