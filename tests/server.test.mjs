import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/store.mjs';
import { createApp } from '../src/server.mjs';
import { tempDir, fakeFetch, connected, seed, CONFIG, NOW } from './helpers.mjs';

const ORIGIN = CONFIG.publicUrl;

async function start(t, { data = {}, fetchImpl = fakeFetch(() => ({})), clock = { now: NOW } } = {}) {
  const store = createStore(await tempDir(t));
  await seed(store, data);
  let counter = 0;
  const server = createApp({ config: CONFIG, store, fetchImpl, now: () => clock.now, randomState: () => `state-${(counter += 1)}` });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, init = {}) => fetch(base + path, { redirect: 'manual', ...init });
  const post = (path, fields, headers = { origin: ORIGIN }) =>
    request(path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(fields).toString() });
  return { store, request, post, fetchImpl, clock };
}

test('health answers ok', async (t) => {
  const { request } = await start(t);
  const response = await request('/health');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});

test('home page shows connection state and callback URLs but no secret or token', async (t) => {
  const { request } = await start(t, { data: connected() });
  const response = await request('/');
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /Connected as someone/);
  assert.match(html, /Connected as Some One/);
  assert.match(html, /https:\/\/poster\.example\.test\/auth\/x\/callback/);
  assert.match(html, /https:\/\/poster\.example\.test\/auth\/linkedin\/callback/);
  for (const secret of ['x-secret-value', 'x-access-token', 'x-refresh-token', 'li-secret-value', 'li-access-token', 'x-client', 'li-client']) {
    assert.ok(!html.includes(secret), secret);
  }
  assert.match(response.headers.get('content-security-policy'), /default-src 'none'/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('home page with nothing saved asks for app details and offers no connect link', async (t) => {
  const { request } = await start(t);
  const html = await (await request('/')).text();
  assert.match(html, /App details needed/);
  assert.doesNotMatch(html, /href="\/auth\/x\/start"/);
});

test('account names are escaped', async (t) => {
  const data = connected();
  data.x.account.username = '<script>alert(1)</script>';
  const { request } = await start(t, { data });
  const html = await (await request('/')).text();
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.match(html, /&lt;script&gt;/);
});

test('saving app details stores them and clears any earlier sign-in', async (t) => {
  const { post, store } = await start(t, { data: connected() });
  const response = await post('/settings/x', { clientId: ' new-id ', clientSecret: 'new-secret' });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/?notice=saved');
  assert.deepEqual((await store.read()).x, { clientId: 'new-id', clientSecret: 'new-secret' });
  assert.ok((await store.read()).linkedin.tokens, 'other platform untouched');
});

test('saving app details is refused from another site or with no origin', async (t) => {
  const { post, store } = await start(t);
  const fields = { clientId: 'id', clientSecret: 'secret' };
  assert.equal((await post('/settings/x', fields, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await post('/settings/x', fields, {})).status, 403);
  assert.equal((await post('/disconnect/x', {}, { origin: 'https://evil.example' })).status, 403);
  assert.deepEqual(await store.read(), {});
});

test('saving app details rejects blank values and oversized forms', async (t) => {
  const { post } = await start(t);
  assert.equal((await post('/settings/x', { clientId: 'id', clientSecret: '' })).status, 400);
  assert.equal((await post('/settings/x', { clientId: 'has space', clientSecret: 's' })).status, 400);
  assert.equal((await post('/settings/x', { clientId: 'id', clientSecret: 'x'.repeat(9000) })).status, 413);
});

test('connect needs saved app details', async (t) => {
  const { request } = await start(t);
  assert.equal((await request('/auth/x/start')).status, 400);
});

test('X connect redirects to X, then the callback stores tokens and the account', async (t) => {
  const fetchImpl = fakeFetch((call) =>
    call.url.endsWith('/oauth2/token')
      ? { json: { access_token: 'fresh-access', refresh_token: 'fresh-refresh', expires_in: 7200 } }
      : { json: { data: { id: '42', username: 'someone' } } },
  );
  const { request, store } = await start(t, { data: { x: { clientId: 'x-client', clientSecret: 'x-secret-value' } }, fetchImpl });

  const begin = await request('/auth/x/start');
  assert.equal(begin.status, 302);
  const authorize = new URL(begin.headers.get('location'));
  assert.equal(authorize.hostname, 'x.com');
  assert.equal(authorize.searchParams.get('state'), 'state-1');
  assert.equal(authorize.searchParams.get('redirect_uri'), 'https://poster.example.test/auth/x/callback');

  const finish = await request('/auth/x/callback?code=the-code&state=state-1');
  assert.equal(finish.status, 302);
  assert.equal(finish.headers.get('location'), '/?notice=connected');
  const saved = (await store.read()).x;
  assert.equal(saved.tokens.accessToken, 'fresh-access');
  assert.equal(saved.tokens.expiresAt, NOW + 7200_000);
  assert.deepEqual(saved.account, { id: '42', username: 'someone' });
  const exchange = new URLSearchParams(fetchImpl.calls[0].body);
  assert.equal(exchange.get('code'), 'the-code');
  assert.ok(exchange.get('code_verifier').length >= 43);

  // The state is single-use.
  assert.equal((await request('/auth/x/callback?code=the-code&state=state-1')).status, 400);
});

test('LinkedIn connect stores the member URN', async (t) => {
  const fetchImpl = fakeFetch((call) =>
    call.url.endsWith('/accessToken') ? { json: { access_token: 'li-fresh', expires_in: 5184000 } } : { json: { sub: 'abc', name: 'Some One' } },
  );
  const { request, store } = await start(t, { data: { linkedin: { clientId: 'li-client', clientSecret: 'li-secret-value' } }, fetchImpl });
  const begin = await request('/auth/linkedin/start');
  assert.equal(new URL(begin.headers.get('location')).hostname, 'www.linkedin.com');
  assert.equal((await request('/auth/linkedin/callback?code=c&state=state-1')).status, 302);
  assert.deepEqual((await store.read()).linkedin.account, { urn: 'urn:li:person:abc', name: 'Some One' });
});

test('callback rejects an unknown, expired or cross-platform state and a denied sign-in', async (t) => {
  const { request, clock, fetchImpl } = await start(t, { data: connected() });
  assert.equal((await request('/auth/x/callback?code=c&state=never-issued')).status, 400);

  await request('/auth/x/start');
  assert.equal((await request('/auth/linkedin/callback?code=c&state=state-1')).status, 400);

  await request('/auth/x/start');
  clock.now += 11 * 60 * 1000;
  assert.equal((await request('/auth/x/callback?code=c&state=state-2')).status, 400);

  await request('/auth/x/start');
  const denied = await request('/auth/x/callback?error=access_denied&state=state-3');
  assert.equal(denied.status, 400);
  assert.match(await denied.text(), /did not approve the sign-in \(access_denied\)/);
  assert.equal(fetchImpl.calls.length, 0);
});

test('a failed code exchange reports the platform error and saves nothing', async (t) => {
  const fetchImpl = fakeFetch(() => ({ status: 400, json: { error: 'invalid_request', error_description: 'Value passed for the authorization code was invalid.' } }));
  const { request, store } = await start(t, { data: { x: { clientId: 'x-client', clientSecret: 'x-secret-value' } }, fetchImpl });
  await request('/auth/x/start');
  const response = await request('/auth/x/callback?code=bad&state=state-1');
  assert.equal(response.status, 502);
  const html = await response.text();
  assert.match(html, /authorization code was invalid/);
  assert.ok(!html.includes('x-secret-value'));
  assert.equal((await store.read()).x.tokens, undefined);
});

test('disconnect removes the sign-in but keeps the app details', async (t) => {
  const { post, store } = await start(t, { data: connected() });
  assert.equal((await post('/disconnect/x', {})).status, 302);
  assert.deepEqual((await store.read()).x, { clientId: 'x-client', clientSecret: 'x-secret-value' });
});

test('unknown paths and platforms return 404', async (t) => {
  const { request, post } = await start(t);
  assert.equal((await request('/nope')).status, 404);
  assert.equal((await request('/auth/mastodon/start')).status, 404);
  assert.equal((await post('/settings/mastodon', { clientId: 'a', clientSecret: 'b' })).status, 404);
});
