const $ = id => document.getElementById(id);
let token = '', session = null, job = null, localStage = '', pending = '';
const stages = ['welcome', 'intake', 'sample', 'review', 'prepare', 'twin', 'reflection', 'done'];
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
  if (!response.ok) throw new Error(result.error || 'The request failed.');
  return result;
}
function busy() {
  document.querySelectorAll('button,input,textarea').forEach(el => { el.disabled = Boolean(job); });
  $('reset').disabled = false;
  $('status').textContent = job ? 'Working locally… the first model response may take longer.' : '';
}
async function run(work) {
  if (job) return;
  const controller = new AbortController(); job = controller;
  errorMessage(); busy();
  try { await work(controller.signal); }
  catch (error) { if (!controller.signal.aborted) errorMessage(error.message); }
  finally {
    if (job === controller) { job = null; pending = ''; render(); busy(); }
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

    button.type = 'button';
    button.className = 'secondary';
    button.textContent = suggestion.label;
    button.title = suggestion.request;
    button.disabled = Boolean(job);

    button.onclick = () => run(signal =>
      talk('suggestion', '', signal, suggestion.id)
    );

    container.append(button);
  }

  $('suggestion-note').hidden =
    session?.suggestionStatus !== 'skipped';

  $('suggestion-note').textContent =
    'You chose to continue without shortcuts. Ask your own question below.';
}
function render() {
  const stage = localStage || session?.stage || 'welcome';
  stages.forEach(id => { $(id).hidden = id !== stage; });
  $('reset').hidden = !session;
  renderSuggestions();
  if (!session) return;
  thread('intake-thread', session.intake, 'A question for you');
  thread('twin-thread', session.messages, 'Possible future self');
  if (pending) bubble($('twin-thread'), { role: 'assistant', content: pending }, 'Possible future self');
  $('twin-title').textContent = `${session.name}, a little further ahead.`;
  $('facts').replaceChildren(...session.facts.map(fact => {
    const item = document.createElement('li'); item.textContent = fact; return item;
  }));
  $('open-scene').hidden = session.messages.length > 0;
  $('twin-controls').hidden = session.messages.length === 0;
  const m = session.metrics;
  $('metrics').textContent = m ? `First text: ${m.firstTokenMs ?? '—'} ms · Total: ${m.totalMs} ms · Generation: ${m.tokensPerSecond ?? '—'} tokens/s` : '';
  $('saved-reflection').textContent = session.reflection || 'No reflection entered.';
}
function addClaim(value = '', evidence = '') {
  const box = document.createElement('div'); box.className = 'claim';
  const label = document.createElement('label'); label.textContent = 'Profile statement';
  const input = document.createElement('textarea'); input.value = value; input.maxLength = 200; input.rows = 2;
  label.append(input);
  const source = document.createElement('small'); source.textContent = evidence || 'Provided or edited by you; not independently verified.';
  const remove = document.createElement('button'); remove.className = 'secondary'; remove.textContent = 'Remove';
  remove.onclick = () => box.remove();
  box.append(label, source, remove); $('claims').append(box);
}
function editProfile(manual = false) {
  $('cancel-edit').hidden = session.stage === 'review';
  localStage = 'review'; $('claims').replaceChildren();
  const facts = session.facts;
  if (facts.length) facts.forEach(fact => addClaim(fact));
  else if (!manual && session.claims.length) session.claims.forEach(c => addClaim(c.text, `${c.sourceId}: “${c.quote}”`));
  else { addClaim(); addClaim(); }
  $('review-note').textContent = manual
    ? 'Manual profile: write two to six things you want the twin to know. These are your statements, not AI-inferred findings.'
    : session.notice || 'Correcting the profile starts a fresh scene and clears the old twin conversation.';
  render(); busy();
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
  $('status').textContent = mode === 'generate'
    ? 'Generating three personal starting points…'
    : 'Continuing without buttons…';

  session = await api(
    '/api/suggestions',
    {
      profileVersion: session.profileVersion,
      mode
    },
    signal
  );

  localStage = '';
  render();

  $('status').textContent =
    'Your future self is preparing its opening…';

  if (session.messages.length === 0) {
    await talk('open', '', signal);
  }
}
async function talk(action, text, signal, suggestionId = '') {
  const selected = action === 'suggestion'
    ? session.suggestions.find(item => item.id === suggestionId)
    : null;

  if (action === 'suggestion' && !selected) {
    throw new Error('This button is no longer available.');
  }

  pending = '';
  render();

  if (action !== 'open') {
    bubble(
      $('twin-thread'),
      {
        role: 'user',
        content: selected?.label || text
      },
      'You'
    );
  }

  const paragraph = bubble(
    $('twin-thread'),
    {
      role: 'assistant',
      content: '…'
    },
    'Possible future self'
  );

  const response = await fetch('/api/twin', {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      'X-Future-Self': '1',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({
      action,
      text,
      suggestionId
    })
  });

  if (!response.ok) {
    throw new Error(
      (await response.json()).error || 'Generation failed.'
    );
  }

  let complete = false;

  for await (const event of events(response.body)) {
    signal.throwIfAborted();

    if (event.type === 'token') {
      pending += event.text;
      paragraph.textContent = pending;

      $('twin-thread').scrollTop =
        $('twin-thread').scrollHeight;
    }

    if (event.type === 'error') {
      throw new Error(event.error);
    }

    if (event.type === 'done') {
      session = event.session;
      complete = true;
    }
  }

  signal.throwIfAborted();

  if (!complete) {
    throw new Error(
      'The stream was interrupted. Retry your message.'
    );
  }

  $('message').value = '';
  pending = '';
  render();
}
$('welcome-form').onsubmit = event => {
  event.preventDefault();
  run(async signal => {
    const result = await api('/api/session', { name: $('name').value, consent: $('consent').checked }, signal);
    token = result.token; session = result.session; localStage = ''; render();
  });
};
$('answer-form').onsubmit = event => {
  event.preventDefault();
  run(async signal => {
    session = await api('/api/answer', { text: $('answer').value }, signal);
    $('answer').value = ''; render();
  });
};
function readSample() {
  return {
    text: $('sample-text').value, context: $('sample-context').value,
    authored: $('authored').checked, typical: $('typical').checked,
    style: document.querySelector('input[name="style"]:checked')?.value || 'none'
  };
}
$('sample-form').onsubmit = event => {
  event.preventDefault();
  run(async signal => {
    session = await api('/api/sample', readSample(), signal);
    editProfile();
  });
};
$('manual').onclick = () => editProfile(true);
$('edit-profile').onclick = () => editProfile();
$('cancel-edit').onclick = () => { localStage = ''; render(); };
$('add-claim').onclick = () => {
  if ($('claims').children.length < 6) addClaim();
};
$('confirm-profile').onclick = () => run(async signal => {
  const facts = [...$('claims').querySelectorAll('textarea')]
    .map(el => el.value.trim())
    .filter(Boolean);

  session = await api(
    '/api/profile',
    {
      facts,
      sample: readSample()
    },
    signal
  );

  localStage = '';
  render();

  await prepareConversation(signal);
});
$('retry-suggestions').onclick = () =>
  run(signal => prepareConversation(signal));

$('skip-suggestions').onclick = () =>
  run(signal => prepareConversation(signal, 'skip'));

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
  job?.abort(); job = null; token = ''; session = null; localStage = ''; pending = '';
  document.querySelectorAll('form').forEach(form => form.reset());
  $('claims').replaceChildren(); $('intake-thread').replaceChildren(); $('twin-thread').replaceChildren();
  $('facts').replaceChildren(); $('saved-reflection').textContent = '';
  $('twin-title').textContent = 'Your future self'; $('review-note').textContent = ''; $('metrics').textContent = '';
  errorMessage(); render(); busy();
  try { if (oldToken) await api('/api/session', undefined, undefined, 'DELETE', oldToken); }
  catch { errorMessage('Browser view cleared. Server deletion could not be confirmed; the old session expires after inactivity.'); }
};
$('export').onclick = () => {
  if (!confirm('These notes contain your confirmed profile and conversation. Save them on this computer?')) return;
  const notes = { exportedAt: new Date().toISOString(), label: 'AI-generated simulation, not a prediction',
    facts: session.facts, conversation: session.messages, reflection: session.reflection, lastResponseMetrics: session.metrics };
  const url = URL.createObjectURL(new Blob([JSON.stringify(notes, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = `session-notes-${Date.now()}.json`;
  link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
};
async function initialize() {
  try {
    const info = await api('/api/info', undefined, undefined, 'GET');
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
    $('health').textContent = `Local model available: ${health.model}`;
  } catch (error) { $('health').textContent = `Model not ready: ${error.message}`; }
}
render(); initialize();
