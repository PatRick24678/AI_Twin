import assert from 'node:assert/strict';

// Deterministic responses for regression tests ONLY. Never imported by the app.
// The old chat/button tests need a completed interview, not a live API call.
export function fixtureInterviewTurn(messages) {
  const data = JSON.parse(messages[1].content);
  const input = data.CURRENT_INPUT;
  const n = data.answeredOrSkippedTurns;
  // Four core questions, then secondary topics. From question 5 it offers "last"; the controller decides.
  const topics = ['role', 'friction', 'communication', 'retain', 'tasks', 'quality', 'desired_change',
    'decisions', 'ai_experience', 'dependencies', 'tools'];
  const done = Boolean(data.activeQuestion?.last) && Boolean(input);
  const value = {
    acknowledgement: '',
    question: done
      ? { topic: 'none', text: '', gap: '', last: false }
      : { topic: topics[n % topics.length], text: `Fictional test question ${n + 1}?`,
        gap: n >= topics.length ? 'A further fictional detail.' : '', last: n >= 4 },
    observations: [], boundaries: [], retractions: [], stopQuote: ''
  };
  if (input?.kind === 'answer') {
    for (const topic of n === 1 ? ['role', 'workflow'] : [data.activeQuestion.topic]) {
      value.observations.push({
        topic, statement: input.text, sourceMessageId: input.id,
        quote: input.text, replacesId: ''
      });
    }
  }
  return value;
}

export function withInterviewFixture(model) {
  return {
    name: model.name,
    health: () => model.health(),
    chat(messages, options = {}) {
      if (options.schema?.properties?.question) return Promise.resolve({
        text: JSON.stringify(fixtureInterviewTurn(messages)),
        metrics: { firstTokenMs: 1, totalMs: 2, inputTokens: 10, outputTokens: 20 }
      });
      return model.chat(messages, options);
    }
  };
}

export async function completeTestInterview(base, token, answers) {
  async function send(path, data, method = 'POST') {
    const response = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Future-Self': '1', Authorization: `Bearer ${token}` },
      ...(data === undefined ? {} : { body: JSON.stringify(data) })
    });
    const result = await response.json();
    assert.equal(response.ok, true, `${path}: HTTP ${response.status}: ${JSON.stringify(result)}`);
    return result;
  }
  let state = await send('/api/session', undefined, 'GET');
  state = await send('/api/interview/next', { requestId: state.interview.requestId });
  for (const text of answers) {
    state = await send('/api/answer', { questionId: state.interview.questionId, text });
  }
  // Skip the remaining questions: skips are never answers, so style and profile evidence stay unchanged.
  while (state.interview.status === 'waiting') {
    state = await send('/api/answer', { questionId: state.interview.questionId, kind: 'skip' });
  }
  assert.equal(state.interview.status, 'complete');
  return send('/api/interview/continue', {});
}
