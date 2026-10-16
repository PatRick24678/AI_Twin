import assert from 'node:assert/strict';
// Regression-test adapter ONLY. It drives the real draft and confirmation endpoints.
// Production does not accept the old { facts: [...] } profile request anymore.
export async function profileSubmission(base, token, facts, sample) {
  const headers = { 'Content-Type': 'application/json', 'X-Future-Self': '1', Authorization: `Bearer ${token}` };
  let response = await fetch(base + '/api/session', { headers });
  assert.equal(response.ok, true);
  let state = await response.json();
  if (state.stage === 'sample') {
    response = await fetch(base + '/api/sample', { method: 'POST', headers,
      body: JSON.stringify({ text: '', context: '', style: 'none', ...sample, mode: 'manual' }) });
    assert.equal(response.ok, true); state = await response.json();
  }
  const source = state.profile?.entries || state.profileDraft?.entries || [], used = new Set();
  return { profileVersion: state.profileVersion, draftId: state.profileDraft?.id, acknowledged: true,
    entries: facts.map(value => {
      const match = source.find(item => item.text === value && !used.has(item.id));
      if (match) used.add(match.id);
      return { id: match?.id || '', topic: match?.topic || 'other', text: value, scope: match?.scope || '' };
    }) };
}
