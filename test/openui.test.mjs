// Generative UI (OpenUI) in the final chat only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { splitReply, spokenPart } from '../public/openui-reply.js';
import { twinMessages, problemMessages, TWIN_VISUALS } from '../lib/prompts.mjs';
import { OPENUI_COMPONENTS } from '../lib/openui-components.mjs';
import { OPENUI_LANG_RULES } from '../lib/openui-prompt.mjs';
import { interviewMessages } from '../lib/interviewer.mjs';
import { createInterview } from '../lib/interview-state.mjs';
import { createApp } from '../server.mjs';

const reply = 'Here are three first steps.\n\n```openui\nroot = Card([steps])\nsteps = Steps([s1])\ns1 = StepsItem("Map the week", "List recurring tasks.")\n```\n';

test('a reply splits into spoken words and an OpenUI block', () => {
  assert.deepEqual(splitReply(reply), {
    words: 'Here are three first steps.',
    ui: 'root = Card([steps])\nsteps = Steps([s1])\ns1 = StepsItem("Map the week", "List recurring tasks.")',
    complete: true
  });
  assert.equal(spokenPart(reply), 'Here are three first steps.');
  assert.deepEqual(splitReply('Just words, no block.'), { words: 'Just words, no block.', ui: '', complete: true });
});

test('while streaming, a half-written fence is hidden and an open block is drawn as far as it goes', () => {
  assert.equal(splitReply('Here you go.\n``', { streaming: true }).words, 'Here you go.');
  assert.equal(splitReply('Here you go.\n```open', { streaming: true }).words, 'Here you go.');
  const partial = splitReply('Here you go.\n```openui\nroot = Card([', { streaming: true });
  assert.deepEqual(partial, { words: 'Here you go.', ui: 'root = Card([', complete: false });
  // Code that is not an OpenUI block stays in the words once the reply is complete.
  assert.equal(splitReply('Use `git status`.').words, 'Use `git status`.');
});

test('only the final chat is taught OpenUI; the interview is not', () => {
  const session = { name: 'Alex', messages: [], answers: [], facts: [], profileVersion: 1 };
  for (const messages of [twinMessages(session, 'open'), twinMessages(session, 'open', '', { voice: true }),
    problemMessages({ ...session, problemThreads: {} }, { id: 'p1', title: 'Slow replies', detail: '' }, 'open')]) {
    assert.ok(messages[0].content.includes(TWIN_VISUALS));
  }
  assert.ok(!JSON.stringify(interviewMessages(createInterview())).match(/openui/i));
  assert.ok(!JSON.stringify(interviewMessages(createInterview(), '', { voice: true })).match(/openui/i));
});

test('the prompt names only the allowed components and asks for a block only when there is structure', () => {
  assert.ok(OPENUI_COMPONENTS.every(name => TWIN_VISUALS.includes(name)));
  assert.ok(!OPENUI_LANG_RULES.includes('Your ENTIRE response must be'));
  assert.match(TWIN_VISUALS, /MUST go in ONE visual block/);
  assert.match(TWIN_VISUALS, /purely conversational reply .* has no block/);
  assert.match(TWIN_VISUALS, /```openui/);
});

test('the server serves the OpenUI renderer from its own origin', async t => {
  const model = { name: 'OPENUI-TEST-NO-REAL-API', health: async () => ({ ok: true }),
    async chat() { return { text: reply, metrics: {} }; } };
  const server = createApp(model, null);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const [path, type] of [['/openui-reply.js', /^text\/javascript/], ['/vendor/openui/openui-bundle.min.js', /^text\/javascript/],
    ['/vendor/openui/openui-styles.css', /^text\/css/]]) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get('content-type'), type);
  }
  assert.match(await (await fetch(base + '/vendor/openui/openui-bundle.min.js')).text(), /__OpenUI/);
});
