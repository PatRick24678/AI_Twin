import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createApp, hostingOptions } from '../server.mjs';
import { createCryptoBox, newDataKey } from '../lib/crypto-box.mjs';
import { openStore } from '../lib/store.mjs';
import { fixtureInterviewTurn } from '../test-support/interview-fixture.mjs';

// Hosting settings with fictional origins and codes. No model or provider is contacted.
const ORIGIN = 'https://future-self.example.test', CODE = 'fictional-access-code';
const hosted = (env = {}) => hostingOptions({ PUBLIC_ORIGINS: ORIGIN, ...env });
class GatedModel {
  name = 'HOSTING-TEST-NO-REAL-API';
  gates = []; // Promises the next calls wait for, in order.
  async health() { return { ok: true, model: this.name }; }
  async chat(messages, { signal } = {}) {
    const gate = this.gates.shift();
    if (gate) await gate;
    signal?.throwIfAborted();
    return { text: JSON.stringify(fixtureInterviewTurn(messages)), metrics: {} };
  }
}
async function start(t, options, { model = new GatedModel(), store = null } = {}) {
  const server = createApp(model, null, store, null, options);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const port = server.address().port;
  // Raw HTTP so the test can choose the Host header, as a proxy in front of the app would send it.
  function call(path, { body, token = '', host = `127.0.0.1:${port}`, headers = {} } = {}) {
    return new Promise((resolve, reject) => {
      const data = body === undefined ? null : JSON.stringify(body);
      const req = http.request({ port, path, method: data ? 'POST' : 'GET', headers: { Host: host, 'X-Future-Self': '1',
        ...(data ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers } },
      res => {
        let text = '';
        res.setEncoding('utf8').on('data', chunk => { text += chunk; }).on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, body: text ? JSON.parse(text) : null }));
      });
      req.on('error', reject); req.end(data);
    });
  }
  return { call, model };
}
const guest = (extra = {}) => ({ name: 'Alex', consent: true, ...extra });

test('hosting settings default to the local prototype and reject unsafe values', () => {
  assert.deepEqual({ ...hostingOptions({}) },
    { origins: [], proxyHops: 0, accessCode: '', aiConcurrency: 1, maxSessions: 20, hsts: false });
  const options = hostingOptions({ PUBLIC_ORIGINS: `${ORIGIN}/, https://b.example.test`, TRUST_PROXY: '1', ACCESS_CODE: ` ${CODE} `,
    AI_CONCURRENCY: '4', MAX_SESSIONS: '40', FUTURE_SELF_SECURE_COOKIES: '1' });
  assert.deepEqual({ ...options }, { origins: [ORIGIN, 'https://b.example.test'], proxyHops: 1, accessCode: CODE,
    aiConcurrency: 4, maxSessions: 40, hsts: true });
  for (const env of [{ PUBLIC_ORIGINS: 'http://future-self.example.test' }, { PUBLIC_ORIGINS: `${ORIGIN}/path` },
    { AI_CONCURRENCY: '0' }, { AI_CONCURRENCY: 'many' }, { MAX_SESSIONS: '2.5' }, { TRUST_PROXY: '9' }]) {
    assert.throws(() => hostingOptions(env), undefined, JSON.stringify(env));
  }
});

test('a hosted server answers only to its public origin and sends HSTS', async t => {
  const { call } = await start(t, hosted({ FUTURE_SELF_SECURE_COOKIES: '1' }));
  const local = await call('/api/info');
  assert.equal(local.status, 403);
  assert.equal(local.body.error, 'Unknown host.');
  const info = await call('/api/info', { host: 'future-self.example.test' });
  assert.equal(info.status, 200);
  assert.equal(info.headers['strict-transport-security'], 'max-age=31536000');
  assert.equal(info.body.accessCode, false);
  const crossSite = await call('/api/session', { host: 'future-self.example.test', body: guest(), headers: { Origin: 'https://evil.example.test' } });
  assert.equal(crossSite.status, 403);
  const sameSite = await call('/api/session', { host: 'future-self.example.test', body: guest(), headers: { Origin: ORIGIN } });
  assert.equal(sameSite.status, 201);
});

test('the local server keeps its localhost-only check and sends no HSTS', async t => {
  const { call } = await start(t, hostingOptions({}));
  const info = await call('/api/info');
  assert.equal(info.status, 200);
  assert.equal(info.headers['strict-transport-security'], undefined);
  assert.equal((await call('/api/info', { host: 'future-self.example.test' })).status, 403);
});

test('the access code gates guest sessions and new accounts, but not logins', async t => {
  const store = openStore({ path: ':memory:', box: createCryptoBox(newDataKey()) });
  t.after(() => store.close());
  const { call } = await start(t, hostingOptions({ ACCESS_CODE: CODE }), { store });
  assert.equal((await call('/api/info')).body.accessCode, true);
  assert.equal((await call('/api/session', { body: guest() })).status, 403);
  assert.equal((await call('/api/session', { body: guest({ accessCode: 'wrong' }) })).status, 403);
  assert.equal((await call('/api/session', { body: guest({ accessCode: ` ${CODE} ` }) })).status, 201);
  const account = { email: 'alex@example.test', password: 'a fictional long passphrase', name: 'Alex', consent: true };
  assert.equal((await call('/api/auth/signup', { body: account })).status, 403);
  assert.equal((await call('/api/auth/signup', { body: { ...account, accessCode: CODE } })).status, 201);
  const login = await call('/api/auth/login', { body: { email: account.email, password: account.password } });
  assert.equal(login.status, 200);
});

test('wrong access codes are throttled per visitor address, read from the trusted proxy entry', async t => {
  const { call } = await start(t, hostingOptions({ ACCESS_CODE: CODE, TRUST_PROXY: '1' }));
  // A client-supplied entry before the proxy's own is ignored, so it cannot dodge the throttle.
  const from = (ip, spoof = '') => ({ 'X-Forwarded-For': `${spoof ? `${spoof}, ` : ''}${ip}` });
  for (let i = 0; i < 5; i++) assert.equal((await call('/api/session', { body: guest({ accessCode: 'wrong' }), headers: from('203.0.113.1', `198.51.100.${i}`) })).status, 403);
  assert.equal((await call('/api/session', { body: guest({ accessCode: CODE }), headers: from('203.0.113.1') })).status, 429);
  assert.equal((await call('/api/session', { body: guest({ accessCode: CODE }), headers: from('203.0.113.2') })).status, 201);
});

test('with AI_CONCURRENCY above 1, two participants are served at the same time', async t => {
  const { call, model } = await start(t, hostingOptions({ AI_CONCURRENCY: '2' }));
  let release;
  model.gates.push(new Promise(resolve => { release = resolve; }));
  const a = (await call('/api/session', { body: guest() })).body, b = (await call('/api/session', { body: guest() })).body;
  const pending = call('/api/interview/next', { token: a.token, body: { requestId: a.session.interview.requestId } });
  await new Promise(resolve => setTimeout(resolve, 50)); // A's model call is now waiting.
  const second = await call('/api/interview/next', { token: b.token, body: { requestId: b.session.interview.requestId } });
  assert.equal(second.status, 200);
  release();
  assert.equal((await pending).status, 200);
});

test('MAX_SESSIONS caps open sessions', async t => {
  const { call } = await start(t, hostingOptions({ MAX_SESSIONS: '2' }));
  assert.equal((await call('/api/session', { body: guest() })).status, 201);
  assert.equal((await call('/api/session', { body: guest() })).status, 201);
  assert.equal((await call('/api/session', { body: guest() })).status, 429);
});
