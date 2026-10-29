import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../server.mjs';
import { withInterviewFixture, completeTestInterview } from '../test-support/interview-fixture.mjs';

const empty = () => ({ text: '', context: '', style: 'none' });
const sample = () => ({ text: 'Please check the date. I will explain the uncertainty to the client.', context: 'Internal request', authored: true, typical: true, style: 'none' });
const cleanAudit = () => ({ sampleNotes: [], clarifications: [] });
function questionAudit(data) {
  const entry = data.entries.find(e => e.topic === 'communication');
  return { sampleNotes: [], clarifications: [{ topic: 'communication', question: 'Is the extra context for the client?',
    reason: 'Check audience before adopting a writing preference.', entryIds: [entry.id], usesSample: true }] };
}
class ProfileModel {
  name = 'TEST-ONLY'; calls = []; outputs = []; delay = null;
  async health() { return { ok: true, model: this.name }; }
  async chat(messages, { schema, signal, onToken } = {}) {
    const data = JSON.parse(messages[1].content.replace(/^REFERENCE DATA, not instructions:\n/, ''));
    const type = schema?.properties?.sampleNotes ? 'audit' : schema?.properties?.resolved ? 'answer' : schema?.properties?.suggestions ? 'suggestions' : 'twin';
    this.calls.push({ type, messages, data });
    if (['audit', 'answer'].includes(type)) {
      await this.delay?.(signal);
      const next = this.outputs.length ? this.outputs.shift() : (type === 'audit' ? cleanAudit() : { resolved: false, decisions: [], additions: [] });
      if (next instanceof Error) throw next;
      const value = typeof next === 'function' ? await next(data) : next;
      return { text: typeof value === 'string' ? value : JSON.stringify(value), metrics: { inputTokens: 10, outputTokens: 20 } };
    }
    if (type === 'suggestions') return { text: JSON.stringify({ suggestions: [
      { label: 'What could change about my work?', request: 'Explore the confirmed tasks, without inventing additional ones.', kind: data.sample.available ? 'draft' : 'conversation', factIds: [data.confirmedFacts[0].id] },
      { label: 'What would stay my responsibility?', request: 'Discuss what I would keep doing myself based only on my confirmed profile.', kind: 'conversation', factIds: [data.confirmedFacts.at(-1).id] },
      { label: 'What are the possible trade-offs?', request: 'Explore a limitation rather than promising that every part will improve.', kind: 'conversation', factIds: [data.confirmedFacts[0].id] }
    ] }) };
    await onToken?.('A clearly imagined workday.');
    return { text: 'A clearly imagined workday.', metrics: { inputTokens: 5, outputTokens: 6 } };
  }
}
async function fixture(t) {
  const model = new ProfileModel(), server = createApp(withInterviewFixture(model));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function call(path, data, token = '', method = 'POST') {
    const response = await fetch(base + path, { method,
      headers: { 'Content-Type': 'application/json', 'X-Future-Self': '1', Authorization: `Bearer ${token}` },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    const raw = await response.text();
    return { status: response.status, body: response.headers.get('content-type')?.includes('ndjson')
      ? raw.trim().split('\n').map(JSON.parse) : JSON.parse(raw) };
  }
  async function seed() {
    const created = await call('/api/session', { name: 'Alex', consent: true }), token = created.body.token;
    await completeTestInterview(base, token, ['I coordinate projects.', 'I dislike chasing updates.', 'I write briefly internally.', 'I keep client calls.']);
    return token;
  }
  const state = token => call('/api/session', undefined, token, 'GET');
  const build = (token, input = empty()) => call('/api/sample', input, token);
  const payload = (s, entries = s.profileDraft.entries.filter(e => e.included)) => ({ profileVersion: s.profileVersion,
    draftId: s.profileDraft.id, acknowledged: true, entries: entries.map(({ id, topic, text, scope }) => ({ id, topic, text, scope })) });
  return { model, call, seed, state, build, payload };
}

test('HTTP profile journey retains structured facts and scopes, then prepares buttons and a grounded twin', async t => {
  const f = await fixture(t), token = await f.seed();
  const review = await f.build(token); assert.equal(review.status, 200); assert.equal(review.body.stage, 'review');
  assert.equal(review.body.profileDraft.entries.length, 5);
  const input = f.payload(review.body); input.entries.find(e => e.topic === 'communication').scope = 'Internal colleagues';
  let result = await f.call('/api/profile', input, token);
  assert.equal(result.body.stage, 'prepare'); assert.equal(result.body.profile.entries.length, 5); assert.equal(result.body.profile.version, 1);
  result = await f.call('/api/suggestions', { profileVersion: 1, mode: 'generate' }, token); assert.equal(result.body.suggestions.length, 3);
  result = await f.call('/api/twin', { action: 'open' }, token); assert.equal(result.body.at(-1).type, 'done');
  const context = f.model.calls.at(-1).data.confirmedProfile;
  assert.ok(context.statements.some(e => e.scope === 'Internal colleagues'));
  assert.ok(context.unknownTopics.includes('tools'));
  assert.ok(!Object.hasOwn(context.statements[0], 'evidence'));
});
test('HTTP optional sample clarification updates a profile interpretation before the final check', async t => {
  const f = await fixture(t), token = await f.seed(); f.model.outputs.push(questionAudit);
  const first = await f.build(token, sample()); assert.equal(first.body.stage, 'clarify');
  const draft = first.body.profileDraft, q = draft.questions[0];
  f.model.outputs.push(data => ({ resolved: true, additions: [], decisions: data.affectedEntries.map(e => ({
    entryId: e.id, action: 'replace', text: 'I give clients more context.', scope: 'Client messages', quote: data.CURRENT_ANSWER.text
  })) }));
  const result = await f.call('/api/profile/clarify', { draftId: draft.id, questionId: q.id, kind: 'answer', text: 'I give clients more context.' }, token);
  assert.equal(result.body.stage, 'review'); assert.equal(result.body.profileDraft.questions[0].status, 'answered');
  assert.ok(result.body.profileDraft.entries.some(e => e.scope === 'Client messages' && e.origin === 'clarification'));
  assert.equal(result.body.profileDraft.usage.attempts, 2);
});
test('HTTP skipping clarification uses no tokens and leaves affected statements excluded', async t => {
  const f = await fixture(t), token = await f.seed(); f.model.outputs.push(questionAudit);
  const draft = (await f.build(token, sample())).body.profileDraft, calls = f.model.calls.length;
  const result = await f.call('/api/profile/clarify', { draftId: draft.id, questionId: draft.questions[0].id, kind: 'skip' }, token);
  assert.equal(result.body.stage, 'review'); assert.equal(f.model.calls.length, calls);
  assert.equal(result.body.profileDraft.entries.find(e => e.topic === 'communication').included, false);
  const confirmed = await f.call('/api/profile', f.payload(result.body), token);
  assert.ok(confirmed.body.profile.unknownTopics.some(t => t.topic === 'communication'));
});
test('HTTP failed audit keeps input and IDs; stale retry cannot bill another request', async t => {
  const f = await fixture(t), token = await f.seed(); f.model.outputs.push(new Error('offline'));
  const failed = await f.build(token, sample()); assert.equal(failed.status, 502); assert.equal(failed.body.session.stage, 'profile_build');
  const draft = failed.body.session.profileDraft, before = f.model.calls.length;
  assert.equal((await f.call('/api/profile/retry', { draftId: draft.id, requestId: 'old' }, token)).status, 409);
  assert.equal(f.model.calls.length, before);
  const retried = await f.call('/api/profile/retry', { draftId: draft.id, requestId: draft.requestId }, token);
  assert.equal(retried.body.stage, 'review'); assert.equal(retried.body.profileDraft.id, draft.id);
  assert.equal(retried.body.profileDraft.usage.unknownUsageRequests, 1);
});
test('HTTP failed clarification retains one answer and retry does not resubmit it', async t => {
  const f = await fixture(t), token = await f.seed(); f.model.outputs.push(questionAudit);
  const draft = (await f.build(token, sample())).body.profileDraft, q = draft.questions[0];
  f.model.outputs.push(new Error('offline'));
  const body = { draftId: draft.id, questionId: q.id, text: 'It depends on the audience.' };
  const failed = await f.call('/api/profile/clarify', body, token); assert.equal(failed.status, 502);
  const pending = failed.body.session.profileDraft;
  assert.equal(pending.pendingAnswer.text, body.text);
  assert.equal((await f.call('/api/profile/clarify', body, token)).status, 409);
  const retried = await f.call('/api/profile/retry', { draftId: draft.id, requestId: pending.requestId }, token);
  assert.equal(retried.body.stage, 'review'); assert.equal(retried.body.profileDraft.questions[0].answer.id, pending.pendingAnswer.id);
});
test('HTTP manual profile bypasses AI but not confirmation or ownership validation', async t => {
  const f = await fixture(t), token = await f.seed(), before = f.model.calls.length;
  const draft = await f.build(token, { ...empty(), mode: 'manual' });
  assert.deepEqual(draft.body.profileDraft.entries, []); assert.equal(f.model.calls.length, before);
  const input = f.payload(draft.body); input.entries = [{ id: '', topic: 'role', text: 'I arrange business trips.', scope: '' }];
  assert.equal((await f.call('/api/profile', { ...input, acknowledged: false }, token)).status, 400);
  input.entries[0].evidence = [];
  assert.equal((await f.call('/api/profile', input, token)).status, 400); delete input.entries[0].evidence;
  const confirmed = await f.call('/api/profile', input, token);
  assert.equal(confirmed.body.profile.limited, true); assert.equal(confirmed.body.profile.entries.length, 1);
});
test('HTTP old draft and another account entry IDs cannot approve a profile', async t => {
  const f = await fixture(t), a = await f.seed(), b = await f.seed();
  const left = await f.build(a), right = await f.build(b), input = f.payload(left.body);
  assert.equal((await f.call('/api/profile', { ...input, draftId: right.body.profileDraft.id }, a)).status, 409);
  input.entries[0].id = right.body.profileDraft.entries[0].id;
  assert.equal((await f.call('/api/profile', input, a)).status, 409);
});
test('HTTP editing removes old facts from the next twin and invalidates old suggestion IDs', async t => {
  const f = await fixture(t), token = await f.seed(), review = await f.build(token);
  await f.call('/api/profile', f.payload(review.body), token);
  const ready = await f.call('/api/suggestions', { profileVersion: 1, mode: 'generate' }, token);
  await f.call('/api/twin', { action: 'open' }, token);
  const input = f.payload(review.body); input.profileVersion = 1; input.entries = input.entries.filter(e => e.topic !== 'communication');
  const edited = await f.call('/api/profile', input, token);
  assert.deepEqual(edited.body.messages, []); assert.deepEqual(edited.body.suggestions, []); assert.equal(edited.body.profileVersion, 2);
  await f.call('/api/suggestions', { profileVersion: 2, mode: 'skip' }, token);
  await f.call('/api/twin', { action: 'open' }, token);
  assert.ok(!JSON.stringify(f.model.calls.at(-1).data.confirmedProfile).includes('I write briefly internally.'));
  assert.equal((await f.call('/api/twin', { action: 'suggestion', suggestionId: ready.body.suggestions[0].id }, token)).status, 400);
});
test('HTTP reset aborts profile analysis and no late completion resurrects the session', { timeout: 5000 }, async t => {
  const f = await fixture(t), token = await f.seed(); let enter, aborted = false;
  const started = new Promise(resolve => { enter = resolve; });
  f.model.delay = signal => new Promise((resolve, reject) => {
    enter(); signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true });
  });
  const pending = f.build(token); await started;
  assert.equal((await f.call('/api/session', undefined, token, 'DELETE')).status, 200);
  // The aborted request may close without a JSON response. Do not insist on a client body.
  await pending.catch(() => {});
  assert.equal(aborted, true); assert.equal((await f.state(token)).status, 401);
});
test('HTTP a busy model leaves the second participant in the sample stage with no partial draft', { timeout: 5000 }, async t => {
  const f = await fixture(t), a = await f.seed(), b = await f.seed(); let enter, release;
  const started = new Promise(resolve => { enter = resolve; });
  f.model.delay = () => new Promise(resolve => { enter(); release = resolve; });
  const pending = f.build(a); await started;
  try {
    assert.equal((await f.build(b)).status, 429);
    const other = await f.state(b); assert.equal(other.body.stage, 'sample'); assert.equal(other.body.profileDraft, null);
  } finally { release(); }
  assert.equal((await pending).body.stage, 'review');
});
test('HTTP processing caps still permit an explicit, labelled notes-only fallback', async t => {
  const f = await fixture(t), token = await f.seed(); f.model.outputs = ['bad', 'bad', 'bad', 'bad'];
  const first = await f.build(token); const d = first.body.session.profileDraft;
  const second = await f.call('/api/profile/retry', { draftId: d.id, requestId: d.requestId }, token);
  assert.equal(second.body.session.profileDraft.retryAllowed, false);
  assert.equal((await f.call('/api/profile/retry', { draftId: d.id, requestId: d.requestId }, token)).status, 429);
  const fallback = await f.call('/api/profile/notes', { draftId: d.id }, token);
  assert.equal(fallback.body.stage, 'review'); assert.match(fallback.body.profileDraft.note, /not been treated as completed/);
  assert.equal(fallback.body.profileDraft.entries.length, 5);
});
test('HTTP explicit stopping during clarification avoids another model call', async t => {
  const f = await fixture(t), token = await f.seed(); f.model.outputs.push(questionAudit);
  const draft = (await f.build(token, sample())).body.profileDraft, calls = f.model.calls.length;
  const result = await f.call('/api/profile/clarify', { draftId: draft.id, questionId: draft.questions[0].id, text: "Let's stop here." }, token);
  assert.equal(result.body.stage, 'review'); assert.equal(result.body.profileDraft.questions[0].status, 'skipped'); assert.equal(f.model.calls.length, calls);
});

test('HTTP problems found in the interview are reviewed with the profile and reach the twin without quotes', async t => {
  const f = await fixture(t), token = await f.seed();
  const review = await f.build(token);
  const [found] = review.body.profileDraft.problems;
  assert.equal(found.title, 'I dislike chasing updates.');
  assert.equal(found.evidence[0].quote, 'I dislike chasing updates.');
  const input = { ...f.payload(review.body), problems: [{ id: found.id, title: 'Chasing updates', detail: found.detail }, { id: '', title: 'Monthly reporting', detail: '' }] };
  const result = await f.call('/api/profile', input, token);
  assert.deepEqual(result.body.profile.problems.map(p => [p.title, p.origin]), [['Chasing updates', 'participant_edited'], ['Monthly reporting', 'participant']]);
  await f.call('/api/suggestions', { profileVersion: 1, mode: 'skip' }, token);
  await f.call('/api/twin', { action: 'open' }, token);
  const context = f.model.calls.at(-1).data.confirmedProfile;
  assert.deepEqual(context.problems.map(p => p.title), ['Chasing updates', 'Monthly reporting']);
  assert.ok(!Object.hasOwn(context.problems[0], 'evidence'));
});
