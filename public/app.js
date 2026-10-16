const $ = id => document.getElementById(id);
let token = '', session = null, job = null, localStage = '', pending = '', reviewKey = '';
let profileTopics = {}, profileLimits = { entries: 112, statement: 240, scope: 180 };
const stages = ['welcome', 'intake', 'sample', 'profile_build', 'clarify', 'review', 'prepare', 'twin', 'reflection', 'done'];
function errorMessage(message = '') { $('error').textContent = message; $('error').hidden = !message; }
async function api(path, data, signal, method = 'POST', auth = token) {
  const response = await fetch(path, {
    method, signal, headers: {
      'Content-Type': 'application/json', 'X-Future-Self': '1',
      ...(auth ? { Authorization: `Bearer ${auth}` } : {})
    }, ...(data === undefined ? {} : { body: JSON.stringify(data) })
  });
  const result = await response.json();
  signal?.throwIfAborted();
  if (!response.ok) {
    if (result.session && auth === token) session = result.session;
    throw new Error(result.error || 'The request failed.');
  }
  return result;
}
function setLoading(title, detail = 'Please wait while this step finishes.') {
  if (!job) return;

  $('loading-title').textContent = title;
  $('loading-detail').textContent = detail;
  $('status').textContent = `${title} ${detail}`;
}

function busy() {
  const waiting = Boolean(job);

  document.querySelectorAll('button,input,textarea,select').forEach(el => {
    el.disabled = waiting;
  });

  // Do not trap the participant in a loading screen.
  $('reset').disabled = false;
  $('loading-indicator').hidden = !waiting;
  renderInterview();
  renderProfileProcess();
  updateProfileCount();

  if (!waiting) {
    $('loading-title').textContent = '';
    $('loading-detail').textContent = '';
    $('status').textContent = '';
  }
}

async function run(work) {
  if (job) return;

  const controller = new AbortController();
  job = controller;
  errorMessage();
  busy();
  setLoading('Working…');

  try {
    await work(controller.signal);
  } catch (error) {
    if (!controller.signal.aborted) errorMessage(error.message);
  } finally {
    // A reset can replace or clear job. Do not touch a newer request.
    if (job === controller) {
      job = null;
      pending = '';
      render();
      busy();
    }
  }
}
function bubble(container, message, label) {
  const card = document.createElement('div');
  card.className = `bubble ${message.role}`;
  const name = document.createElement('strong'); name.textContent = message.role === 'user' ? 'You' : label;
  const paragraph = document.createElement('p'); paragraph.textContent = message.content;
  card.append(name, paragraph); container.append(card);
  return paragraph;
}
function thread(id, messages, label) {
  const container = $(id); container.replaceChildren();
  messages.forEach(message => bubble(container, message, label));
  container.scrollTop = container.scrollHeight;
}
function renderSuggestions() {
  const container = $('suggestions');
  container.replaceChildren();
  for (const suggestion of session?.suggestions || []) {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'secondary';
    button.textContent = suggestion.label;
    button.title = suggestion.request;
    button.disabled = Boolean(job);
    button.onclick = () => run(signal => talk('suggestion', '', signal, suggestion.id));
    container.append(button);
  }
  $('suggestion-note').hidden = session?.suggestionStatus !== 'skipped';
  $('suggestion-note').textContent = 'You chose to continue without shortcuts. Ask your own question below.';
}
function renderInterview() {
  const interview = session?.interview;
  $('answer-form').hidden = interview?.status !== 'waiting';
  $('interview-recovery').hidden = !interview || interview.status !== 'thinking' || Boolean(job);
  $('retry-interview').disabled = Boolean(job) || !interview?.retryAllowed;
  $('interview-ended').hidden = interview?.status !== 'complete';
  const failed = ['processing_limit', 'context_limit'].includes(interview?.finishReason);
  $('interview-ending-note').textContent = failed
    ? 'Processing stopped before every answer could be interpreted. The next step will use only the supported working notes already collected.'
    : (interview?.observationCount || 0) === 0
      ? 'There is not enough context yet for a personal twin. We will not invent the missing details. The next screen lets you optionally add an example or enter your own profile statements.'
      : 'Some details may remain unknown. Next is the optional example and the existing profile-check step; nothing is confirmed automatically.';
  const usage = interview?.usage;
  $('interview-usage').textContent = usage
    ? `Interview requests: ${usage.attempts} · Repairs: ${usage.repairs} · Reported input: ${usage.inputTokens} · Output: ${usage.outputTokens} tokens. Cache read/write: ${usage.cacheReadTokens}/${usage.cacheWriteTokens}. ${usage.unknownUsageRequests ? `${usage.unknownUsageRequests} request(s) have unknown usage; these totals are incomplete. ` : ''}Check the provider Console for billing. No tokens are inferred from word counts.`
    : '';
}

function render() {
  const stage = localStage || session?.stage || 'welcome';
  stages.forEach(id => { $(id).hidden = id !== stage; });
  $('reset').hidden = !session;
  renderSuggestions();
  renderInterview();
  renderProfileProcess();
  if (!session) return;
  if (stage === 'review') renderProfileEditor();
  thread('intake-thread', session.intake, 'Your interviewer');
  thread('twin-thread', session.messages, 'Possible future self');
  if (pending) bubble($('twin-thread'), { role: 'assistant', content: pending }, 'Possible future self');
  $('twin-title').textContent = `${session.name}, a little further ahead.`;
  $('facts').replaceChildren(...(session.profile?.entries || []).map(fact => {
    const item = document.createElement('li'); item.textContent = `${fact.text}${fact.scope ? ` — ${fact.scope}` : ''}`; return item;
  }));
  $('limited-profile').hidden = !session.profile?.limited;
  $('limited-profile').textContent = 'This twin has limited personal context. Missing information should remain unknown; the future workday is a possibility, not a prediction.';
  $('twin-unknown').textContent = session.profile?.unknownTopics.length
    ? `Not established: ${session.profile.unknownTopics.map(item => item.label).join(', ')}.` : '';
  $('open-scene').hidden = session.messages.length > 0;
  $('twin-controls').hidden = session.messages.length === 0;
  const m = session.metrics;
  $('metrics').textContent = m
    ? `Last request — first text: ${m.firstTokenMs ?? '—'} ms · Total: ${m.totalMs} ms · Input: ${m.inputTokens ?? '—'} tokens · Output: ${m.outputTokens ?? '—'} tokens`
    : '';
  $('saved-reflection').textContent = session.reflection || 'No reflection entered.';
}
function renderProfileProcess() {
  const draft = session?.profileDraft;
  $('profile-usage-panel').hidden = !draft;
  const u = draft?.usage;
  $('profile-usage').textContent = u ? `Profile requests: ${u.attempts} · Repairs: ${u.repairs} · Reported input/output: ${u.inputTokens}/${u.outputTokens} tokens · Cache read/write: ${u.cacheReadTokens}/${u.cacheWriteTokens}. ${u.unknownUsageRequests} request(s) have unknown usage. Check the provider Console for billing.` : '';
  $('profile-recovery').hidden = !draft || !['building', 'resolving'].includes(draft.status) || Boolean(job);
  $('retry-profile').disabled = Boolean(job) || !draft?.retryAllowed;
  $('profile-pending-answer').textContent = draft?.pendingAnswer
    ? `Your answer is saved: ${draft.pendingAnswer.text}` : '';
  const question = draft?.questions.find(q => q.status === 'pending');
  $('clarification-question').textContent = question?.question || '';
  $('clarification-reason').textContent = question?.reason || '';
}
function profileGroup(topic) {
  let group = [...$('claims').children].find(item => item.dataset.topic === topic);
  if (!group) {
    group = document.createElement('details'); group.className = 'profile-group'; group.open = true; group.dataset.topic = topic;
    const title = document.createElement('summary'); title.textContent = profileTopics[topic] || topic;
    group.append(title); $('claims').append(group);
  }
  return group;
}
function addProfileEntry(entry = { id: '', topic: 'role', text: '', scope: '', included: true, evidence: [] }) {
  const card = document.createElement('div'); card.className = 'claim'; card.dataset.entryId = entry.id;
  const includeLabel = document.createElement('label'); includeLabel.className = 'check';
  const include = document.createElement('input'); include.type = 'checkbox'; include.className = 'include-entry'; include.checked = entry.included !== false;
  includeLabel.append(include, document.createTextNode(' Include in my twin'));
  const topicLabel = document.createElement('label'); topicLabel.textContent = 'Category';
  const category = document.createElement('select'); category.className = 'entry-topic';
  for (const [id, name] of Object.entries(profileTopics)) {
    const option = document.createElement('option'); option.value = id; option.textContent = name; category.append(option);
  }
  category.value = entry.topic; topicLabel.append(category);
  const statementLabel = document.createElement('label'); statementLabel.textContent = 'Statement';
  const statement = document.createElement('textarea'); statement.className = 'entry-text'; statement.value = entry.text;
  statement.maxLength = profileLimits.statement; statement.rows = 2; statementLabel.append(statement);
  const scopeLabel = document.createElement('label'); scopeLabel.textContent = 'Audience or context (optional)';
  const scope = document.createElement('input'); scope.className = 'entry-scope'; scope.value = entry.scope || '';
  scope.maxLength = profileLimits.scope; scopeLabel.append(scope);
  const status = document.createElement('small'); status.className = 'entry-status';
  status.textContent = entry.status === 'needs_review'
    ? 'Unresolved: excluded by default. Check the wording before deliberately including it.'
    : entry.origin === 'participant_edited' ? 'Written or edited by you; not independently verified.' : 'An interpretation to check, not an independently verified fact.';
  const provenance = document.createElement('details'), title = document.createElement('summary'); title.textContent = 'Why this appeared'; provenance.append(title);
  for (const source of entry.evidence || []) {
    const p = document.createElement('p'); p.className = 'muted'; p.textContent = `${source.label}: “${source.quote}”`; provenance.append(p);
  }
  if (!entry.evidence?.length) { const p = document.createElement('p'); p.textContent = 'Provided by you in this profile editor.'; provenance.append(p); }
  if (entry.wordingBeforeEdit) {
    const p = document.createElement('p'); p.textContent = `Earlier interpretation, before your edit: ${entry.wordingBeforeEdit}`; provenance.append(p);
  }
  const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'secondary'; remove.textContent = 'Remove';
  remove.onclick = () => { const group = card.parentElement; card.remove(); if (!group.querySelector('.claim')) group.remove(); updateProfileCount(); };
  category.onchange = () => {
    const old = card.parentElement; profileGroup(category.value).append(card);
    if (!old.querySelector('.claim')) old.remove(); updateProfileCount();
  };
  statement.oninput = scope.oninput = () => { status.textContent = 'Edited by you. Original quotations explain its origin, not proof of the new wording.'; updateProfileCount(); };
  include.onchange = updateProfileCount;
  card.append(includeLabel, topicLabel, statementLabel, scopeLabel, status, provenance, remove);
  profileGroup(entry.topic).append(card); updateProfileCount();
}
function profileRows() {
  return [...$('claims').querySelectorAll('.claim')].filter(card => card.querySelector('.include-entry').checked).map(card => ({
    id: card.dataset.entryId, topic: card.querySelector('.entry-topic').value,
    text: card.querySelector('.entry-text').value.trim(), scope: card.querySelector('.entry-scope').value.trim()
  }));
}
function updateProfileCount() {
  const entries = profileRows(), all = $('claims').querySelectorAll('.claim').length;
  $('profile-count').textContent = `${entries.length} of ${all} statements included. There is no target score to fill.`;
  $('confirm-profile').disabled = Boolean(job) || !$('approve-profile').checked || entries.length === 0 || entries.some(item => !item.text);
  $('add-claim').disabled = Boolean(job) || all >= profileLimits.entries;
  const unknown = Object.entries(profileTopics).filter(([id]) => id !== 'other' && !entries.some(item => item.topic === id));
  $('profile-unknown').textContent = unknown.length ? unknown.map(([, label]) => label).join(', ') + '. These details will not be filled automatically.' : 'Every topic has at least one included statement. That is not a completeness or accuracy guarantee.';
}
function renderProfileEditor(force = false) {
  const draft = session.profileDraft;
  const key = `${session.profileVersion}:${session.profile ? 'confirmed' : draft?.id || 'none'}`;
  if (!force && key === reviewKey) return;
  reviewKey = key; $('claims').replaceChildren(); $('approve-profile').checked = false;
  const source = session.profile?.entries || draft?.entries || [];
  source.forEach(item => addProfileEntry(item));
  if (!source.length) addProfileEntry();
  const unresolved = session.profile ? session.profile.unresolved
    : (draft?.questions || []).filter(q => ['unresolved', 'skipped'].includes(q.status));
  $('profile-unresolved').hidden = unresolved.length === 0;
  $('profile-unresolved').textContent = unresolved.length ? 'Unresolved questions: ' + unresolved.map(q => q.question).join(' ') + ' Related unconfirmed entries are excluded by default. Only explicitly included statements will guide the twin.' : '';
  $('review-note').textContent = session.profile
    ? 'Editing this profile starts a fresh twin conversation and regenerates its buttons; it does not redo the interview.'
    : draft?.note || 'These statements retain their sources and context. Check the interpretation, not just whether the quoted words are present.';
  $('cancel-edit').hidden = session.stage === 'review'; updateProfileCount();
}
function editProfile() { localStage = 'review'; renderProfileEditor(true); render(); busy(); }
async function profileRequest(path, data, signal) {
  setLoading('Preparing your profile…', 'Keeping interview evidence separate from sample interpretations and unknown details.');
  try { session = await api(path, data, signal); }
  catch (error) {
    if (!signal.aborted) {
      try { session = await api('/api/session', undefined, signal, 'GET'); } catch { /* Keep last state; never resubmit automatically. */ }
    }
    throw error;
  } finally { if (!signal.aborted) { localStage = ''; render(); } }
}
async function* events(body) {
  if (!body) throw new Error('No response stream.');
  const reader = body.getReader(), decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
        if (line) yield JSON.parse(line);
      }
      if (done) break;
    }
    if (buffer.trim()) yield JSON.parse(buffer);
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
async function prepareConversation(signal, mode = 'generate') {
  setLoading(
    mode === 'generate'
      ? 'Creating your personal starting points…'
      : 'Continuing without buttons…',
    mode === 'generate'
      ? 'Choosing three topics from the profile you confirmed.'
      : 'Your confirmed profile will still guide the conversation.'
  );

  session = await api('/api/suggestions', {
    profileVersion: session.profileVersion,
    mode
  }, signal);

  localStage = '';
  render();

  if (session.messages.length === 0) {
    await talk('open', '', signal);
  }
}
async function talk(action, text, signal, suggestionId = '') {
  setLoading(
    action === 'open'
      ? 'Starting your conversation…'
      : 'Your future self is preparing a reply…',
    'Waiting for the first words from Claude.'
  );

  const selected = action === 'suggestion'
    ? session.suggestions.find(item => item.id === suggestionId) : null;
  if (action === 'suggestion' && !selected) throw new Error('This button is no longer available.');
  pending = ''; render();
  if (action !== 'open') bubble($('twin-thread'), {
    role: 'user', content: selected?.label || text
  }, 'You');
  const paragraph = bubble($('twin-thread'), { role: 'assistant', content: '…' }, 'Possible future self');
  const response = await fetch('/api/twin', {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', 'X-Future-Self': '1', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ action, text, suggestionId })
  });
  if (!response.ok) throw new Error((await response.json()).error || 'Generation failed.');
  let complete = false;
  for await (const event of events(response.body)) {
    signal.throwIfAborted();
    if (event.type === 'token') {
      if (event.text && !pending) {
        setLoading(
          'Your future self is replying…',
          'The answer is appearing below as it is generated.'
        );
      }
      pending += event.text; paragraph.textContent = pending;
      $('twin-thread').scrollTop = $('twin-thread').scrollHeight;
    }
    if (event.type === 'error') throw new Error(event.error);
    if (event.type === 'done') { session = event.session; complete = true; }
  }
  signal.throwIfAborted();
  if (!complete) throw new Error('The stream was interrupted. Retry your message.');
  $('message').value = ''; pending = ''; render();
}
async function interviewRequest(path, data, signal) {
  const previousQuestion = session?.interview?.questionId;
  const previousTurns = session?.interview?.turns || 0;
  setLoading(
    previousQuestion ? 'Considering your answer…' : 'Meeting your interviewer…',
    'Claude is preparing one question and updating the working notes.'
  );
  try {
    session = await api(path, data, signal);
  } catch (error) {
    // A network failure can hide a successfully accepted answer. Re-read our own
    // session before offering Retry; do not automatically resend or regenerate.
    if (!signal.aborted) {
      try { session = await api('/api/session', undefined, signal, 'GET'); }
      catch { /* Keep the last known state and the original error. */ }
    }
    throw error;
  } finally {
    if (!signal.aborted) {
      const current = session?.interview;
      if (current && (current.turns > previousTurns || current.status === 'complete')) {
        $('answer').value = '';
      }
      render();
    }
  }
}
$('welcome-form').onsubmit = event => {
  event.preventDefault();
  run(async signal => {
    const result = await api('/api/session', { name: $('name').value, consent: $('consent').checked }, signal);
    token = result.token; session = result.session; localStage = ''; render();
    await interviewRequest('/api/interview/next', { requestId: session.interview.requestId }, signal);
  });
};
$('answer-form').onsubmit = event => {
  event.preventDefault();
  run(signal => interviewRequest('/api/answer', {
    questionId: session.interview.questionId, kind: 'answer', text: $('answer').value
  }, signal));
};
$('skip-question').onclick = () => run(signal => interviewRequest('/api/answer', {
  questionId: session.interview.questionId, kind: 'skip'
}, signal));
$('retry-interview').onclick = () => run(signal => interviewRequest('/api/interview/next', {
  requestId: session.interview.requestId
}, signal));
$('continue-interview').onclick = () => run(async signal => {
  session = await api('/api/interview/continue', {}, signal);
  render();
});
function readSample() {
  return {
    text: $('sample-text').value, context: $('sample-context').value,
    authored: $('authored').checked, typical: $('typical').checked,
    style: document.querySelector('input[name="style"]:checked')?.value || 'none'
  };
}
$('sample-form').onsubmit = event => {
  event.preventDefault(); run(signal => profileRequest('/api/sample', { ...readSample(), mode: 'build' }, signal));
};
$('manual').onclick = () => run(signal => profileRequest('/api/sample', { ...readSample(), mode: 'manual' }, signal));
$('retry-profile').onclick = () => run(signal => profileRequest('/api/profile/retry', {
  draftId: session.profileDraft.id, requestId: session.profileDraft.requestId
}, signal));
$('profile-notes').onclick = () => run(signal => profileRequest('/api/profile/notes', { draftId: session.profileDraft.id }, signal));
async function submitClarification(kind, signal) {
  const question = session.profileDraft.questions.find(item => item.status === 'pending');
  try { await profileRequest('/api/profile/clarify', {
    draftId: session.profileDraft.id, questionId: question.id, kind,
    text: kind === 'answer' ? $('clarification-answer').value : ''
  }, signal); }
  finally {
    if (!signal.aborted && (session.profileDraft?.pendingAnswer || session.profileDraft?.questions.find(q => q.status === 'pending')?.id !== question.id)) {
      $('clarification-answer').value = '';
    }
  }
}
$('clarification-form').onsubmit = event => { event.preventDefault(); run(signal => submitClarification('answer', signal)); };
$('skip-clarification').onclick = () => run(signal => submitClarification('skip', signal));
$('edit-profile').onclick = () => editProfile();
$('cancel-edit').onclick = () => { localStage = ''; render(); };
$('add-claim').onclick = () => { if ($('claims').querySelectorAll('.claim').length < profileLimits.entries) addProfileEntry(); };
$('approve-profile').onchange = updateProfileCount;
$('confirm-profile').onclick = () => run(async signal => {
  session = await api('/api/profile', { draftId: session.profileDraft?.id, profileVersion: session.profileVersion,
    entries: profileRows(), acknowledged: $('approve-profile').checked }, signal);
  localStage = ''; render(); await prepareConversation(signal);
});
$('open-scene').onclick = () => run(signal => talk('open', '', signal));
$('retry-suggestions').onclick = () => run(signal => prepareConversation(signal));
$('skip-suggestions').onclick = () => run(signal => prepareConversation(signal, 'skip'));
$('prepare-edit').onclick = () => editProfile();
$('message-form').onsubmit = event => {
  event.preventDefault(); run(signal => talk('say', $('message').value, signal));
};
$('finish').onclick = () => { localStage = 'reflection'; render(); };
$('reflection-form').onsubmit = event => {
  event.preventDefault();
  run(async signal => {
    session = await api('/api/finish', { reflection: $('reflection-text').value }, signal);
    localStage = ''; render();
  });
};
$('reset').onclick = async () => {
  const oldToken = token;
  job?.abort(); job = null; token = ''; session = null; localStage = ''; pending = ''; reviewKey = '';
  document.querySelectorAll('form').forEach(form => form.reset());
  $('claims').replaceChildren(); $('intake-thread').replaceChildren(); $('twin-thread').replaceChildren();
  $('facts').replaceChildren(); $('saved-reflection').textContent = '';
  for (const id of ['profile-unresolved', 'profile-unknown', 'limited-profile', 'twin-unknown', 'profile-count']) $(id).textContent = '';
  $('profile-unresolved').hidden = true; $('limited-profile').hidden = true;
  $('twin-title').textContent = 'Your future self'; $('review-note').textContent = ''; $('metrics').textContent = '';
  errorMessage(); render(); busy();
  try { if (oldToken) await api('/api/session', undefined, undefined, 'DELETE', oldToken); }
  catch { errorMessage('Browser view cleared. Server deletion could not be confirmed; the old session expires after inactivity.'); }
};
$('export').onclick = () => {
  if (!confirm('These notes contain your confirmed profile, its evidence quotations and conversation. Save them on this computer?')) return;
  const notes = { exportedAt: new Date().toISOString(), label: 'AI-generated simulation, not a prediction',
    profile: session.profile, facts: session.facts, conversation: session.messages, reflection: session.reflection, lastResponseMetrics: session.metrics };
  const url = URL.createObjectURL(new Blob([JSON.stringify(notes, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = `session-notes-${Date.now()}.json`;
  link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
};
async function initialize() {
  try {
    const info = await api('/api/info', undefined, undefined, 'GET');
    profileTopics = info.profileTopics; profileLimits = info.profileLimits;
    const options = [{ id: 'none', label: 'None / not sure', sample: 'Do not infer a preference from these examples.' }, ...info.examples];
    for (const option of options) {
      const label = document.createElement('label');
      const radio = document.createElement('input'); radio.type = 'radio'; radio.name = 'style'; radio.value = option.id;
      radio.checked = option.id === 'none'; radio.defaultChecked = radio.checked;
      const title = document.createTextNode(` ${option.label}`);
      const example = document.createElement('p'); example.textContent = option.sample;
      label.append(radio, title, example); $('examples').append(label);
    }
    const health = await api('/api/health', undefined, undefined, 'GET');
    $('health').textContent = `Claude model access verified: ${health.model}`;
  } catch (error) { $('health').textContent = `Model not ready: ${error.message}`; }
}
render(); initialize();
