import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../server.mjs';
import { withInterviewFixture, completeTestInterview } from '../test-support/interview-fixture.mjs';
import { PROBLEM_EXCHANGES, PROBLEM_OPEN } from '../lib/prompts.mjs';

// Fake model only: profile audit, buttons and twin replies. No provider, no credentials.
class FakeModel {
  name = 'PROBLEMS-TEST-ONLY'; twin = [];
  async health() { return { ok: true, model: this.name }; }
  async chat(messages, { schema, onToken } = {}) {
    if (schema?.properties?.sampleNotes) return { text: JSON.stringify({ sampleNotes: [], clarifications: [] }), metrics: {} };
    this.twin.push(messages);
    await onToken?.('An imagined reply.');
    return { text: `Imagined reply ${this.twin.length}.`, metrics: { inputTokens: 5, outputTokens: 6 } };
  }
}
async function fixture(t) {
  const model = new FakeModel(), server = createApp(withInterviewFixture(model));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  let token = '';
  async function call(path, data, method = 'POST') {
    const response = await fetch(base + path, { method,
      headers: { 'Content-Type': 'application/json', 'X-Future-Self': '1', Authorization: `Bearer ${token}` },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    const raw = await response.text();
    return { status: response.status, body: response.headers.get('content-type')?.includes('ndjson')
      ? raw.trim().split('\n').map(JSON.parse) : JSON.parse(raw) };
  }
  token = (await call('/api/session', { name: 'Alex', consent: true })).body.token;
  await completeTestInterview(base, token, ['I coordinate projects.', 'Chasing late approvals eats my week.']);
  const review = (await call('/api/sample', { text: '', context: '', style: 'none' })).body;
  const confirm = (problems, s = review) => call('/api/profile', { profileVersion: s.profileVersion, draftId: s.profileDraft.id, acknowledged: true,
    entries: (s.profile?.entries || s.profileDraft.entries).map(({ id, topic, text, scope }) => ({ id, topic, text, scope })), problems });
  const [found] = review.profileDraft.problems;
  await confirm([{ id: found.id, title: 'Chasing late approvals', detail: '' }, { id: '', title: 'Monthly reporting', detail: 'Every first Monday.' }]);
  const ready = (await call('/api/suggestions', { profileVersion: 1, mode: 'skip' })).body;
  const twin = data => call('/api/twin', data);
  return { model, call, twin, confirm, problems: ready.profile.problems };
}

test('a problem session has its own thread, focus and prompt, next to the main conversation', async t => {
  const f = await fixture(t), [approvals, reporting] = f.problems;
  let result = await f.twin({ action: 'open', problemId: reporting.id });
  assert.equal(result.body.at(-1).type, 'done');
  let prompt = f.model.twin.at(-1);
  assert.match(prompt[0].content, /PROBLEM SESSION/);
  assert.match(prompt[0].content, /Never claim the problem is solved/);
  assert.deepEqual(JSON.parse(prompt[1].content.replace(/^REFERENCE DATA, not instructions:\n/, '')).focusProblem,
    { title: 'Monthly reporting', detail: 'Every first Monday.' });
  assert.equal(prompt.at(-1).content, PROBLEM_OPEN);
  result = await f.twin({ action: 'say', text: 'Can you draft a checklist?', problemId: reporting.id });
  const session = result.body.at(-1).session;
  assert.deepEqual(session.problemThreads[reporting.id].map(m => m.role), ['assistant', 'user', 'assistant']);
  assert.deepEqual(session.messages, []);
  assert.equal(f.model.twin.at(-1).at(-1).content, 'Can you draft a checklist?');
  result = await f.twin({ action: 'open' });
  prompt = f.model.twin.at(-1);
  assert.doesNotMatch(prompt[0].content, /PROBLEM SESSION/);
  assert.equal(JSON.parse(prompt[1].content.replace(/^REFERENCE DATA, not instructions:\n/, '')).confirmedProfile.problems.length, 2);
  assert.equal(result.body.at(-1).session.messages.length, 1);
  assert.equal(result.body.at(-1).session.problemThreads[approvals.id], undefined);
});

test('problem sessions reject unknown problems and buttons, keep their own limit and reset with the profile', async t => {
  const f = await fixture(t), [approvals] = f.problems;
  assert.equal((await f.twin({ action: 'open', problemId: 'not-a-problem' })).status, 400);
  assert.equal((await f.twin({ action: 'challenge', problemId: approvals.id })).status, 400);
  assert.equal((await f.twin({ action: 'say', text: 'Hi', problemId: approvals.id })).status, 409);
  await f.twin({ action: 'open', problemId: approvals.id });
  assert.equal((await f.twin({ action: 'open', problemId: approvals.id })).status, 409);
  for (let i = 0; i < PROBLEM_EXCHANGES; i++) assert.equal((await f.twin({ action: 'say', text: `Step ${i}`, problemId: approvals.id })).status, 200);
  const over = await f.twin({ action: 'say', text: 'One more', problemId: approvals.id });
  assert.equal(over.status, 409); assert.match(over.body.error, /limited to 6 exchanges/);
  const s = (await f.call('/api/session', undefined, 'GET')).body;
  const edited = (await f.confirm([{ id: approvals.id, title: approvals.title, detail: approvals.detail }], s)).body;
  assert.deepEqual(edited.problemThreads, {});
  assert.equal(edited.profile.problems.length, 1);
});
