import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import * as x from '../src/x.mjs';
import * as linkedin from '../src/linkedin.mjs';
import { fakeFetch, NOW } from './helpers.mjs';

const xApp = { clientId: 'x-client', clientSecret: 'x-secret-value' };
const liApp = { clientId: 'li-client', clientSecret: 'li-secret-value' };

test('X sign-in URL asks for posting, media and offline access with an S256 challenge', () => {
  const { verifier, challenge } = x.createPkce();
  assert.equal(challenge, crypto.createHash('sha256').update(verifier).digest('base64url'));
  const url = new URL(x.buildAuthUrl({ clientId: 'x-client', redirectUri: 'https://p.test/auth/x/callback', state: 's1', challenge }));
  assert.equal(url.origin + url.pathname, 'https://x.com/i/oauth2/authorize');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('state'), 's1');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://p.test/auth/x/callback');
  for (const scope of ['tweet.write', 'media.write', 'offline.access']) {
    assert.ok(url.searchParams.get('scope').split(' ').includes(scope), scope);
  }
});

test('X code exchange authenticates a confidential client with a Basic header', async () => {
  const fetchImpl = fakeFetch(() => ({ json: { access_token: 'a', refresh_token: 'r', expires_in: 7200, scope: 'tweet.write' } }));
  const tokens = await x.exchangeCode(fetchImpl, xApp, { code: 'c', redirectUri: 'https://p.test/cb', verifier: 'v', now: NOW });
  assert.deepEqual(tokens, { accessToken: 'a', refreshToken: 'r', expiresAt: NOW + 7200_000, scope: 'tweet.write' });
  const [call] = fetchImpl.calls;
  assert.equal(call.url, 'https://api.x.com/2/oauth2/token');
  assert.equal(call.headers.authorization, `Basic ${Buffer.from('x-client:x-secret-value').toString('base64')}`);
  const body = new URLSearchParams(call.body);
  assert.equal(body.get('grant_type'), 'authorization_code');
  assert.equal(body.get('code_verifier'), 'v');
  assert.equal(body.get('client_id'), null);
});

test('X public client sends client_id in the body and no Basic header', async () => {
  const fetchImpl = fakeFetch(() => ({ json: { access_token: 'a', expires_in: 7200 } }));
  await x.exchangeCode(fetchImpl, { clientId: 'x-client' }, { code: 'c', redirectUri: 'u', verifier: 'v' });
  assert.equal(fetchImpl.calls[0].headers.authorization, undefined);
  assert.equal(new URLSearchParams(fetchImpl.calls[0].body).get('client_id'), 'x-client');
});

test('X refresh keeps the old refresh token only when no new one is returned', async () => {
  const rotated = fakeFetch(() => ({ json: { access_token: 'a2', refresh_token: 'r2', expires_in: 7200 } }));
  assert.equal((await x.refreshTokens(rotated, xApp, 'r1', NOW)).refreshToken, 'r2');
  const kept = fakeFetch(() => ({ json: { access_token: 'a2', expires_in: 7200 } }));
  assert.equal((await x.refreshTokens(kept, xApp, 'r1', NOW)).refreshToken, 'r1');
});

test('X image upload and post send the documented request bodies', async () => {
  const fetchImpl = fakeFetch((call) => (call.url.endsWith('/media/upload') ? { json: { data: { id: 'm1' } } } : { status: 201, json: { data: { id: 'p1' } } }));
  const mediaId = await x.uploadImage(fetchImpl, 'tok', Buffer.from('png-bytes'));
  const post = await x.createPost(fetchImpl, 'tok', { text: 'hello', mediaIds: [mediaId] });
  assert.equal(post.id, 'p1');
  const [upload, create] = fetchImpl.calls;
  assert.deepEqual(JSON.parse(upload.body), { media: Buffer.from('png-bytes').toString('base64'), media_category: 'tweet_image' });
  assert.equal(upload.headers.authorization, 'Bearer tok');
  assert.equal(create.url, 'https://api.x.com/2/tweets');
  assert.deepEqual(JSON.parse(create.body), { text: 'hello', media: { media_ids: ['m1'] } });
  assert.equal(x.postUrl('someone', 'p1'), 'https://x.com/someone/status/p1');
});

test('X text-only post omits the media field', async () => {
  const fetchImpl = fakeFetch(() => ({ status: 201, json: { data: { id: 'p1' } } }));
  await x.createPost(fetchImpl, 'tok', { text: 'hello' });
  assert.deepEqual(JSON.parse(fetchImpl.calls[0].body), { text: 'hello' });
});

test('API errors report the status and platform message but never the token', async () => {
  const fetchImpl = fakeFetch(() => ({ status: 403, json: { title: 'Forbidden', detail: 'You are not permitted to perform this action.' } }));
  await assert.rejects(x.createPost(fetchImpl, 'super-secret-token', { text: 'hi' }), (error) => {
    assert.match(error.message, /X post failed \(HTTP 403\)/);
    assert.match(error.message, /not permitted/);
    assert.ok(!error.message.includes('super-secret-token'));
    return true;
  });
});

test('a network failure is reported as unreachable, not as a crash', async () => {
  const fetchImpl = async () => {
    throw new Error('getaddrinfo ENOTFOUND');
  };
  await assert.rejects(x.createPost(fetchImpl, 't', { text: 'hi' }), /could not reach the server/);
});

test('LinkedIn sign-in URL requests member posting and profile scopes', () => {
  const url = new URL(linkedin.buildAuthUrl({ clientId: 'li-client', redirectUri: 'https://p.test/auth/linkedin/callback', state: 's2' }));
  assert.equal(url.origin + url.pathname, 'https://www.linkedin.com/oauth/v2/authorization');
  assert.deepEqual(url.searchParams.get('scope').split(' '), ['openid', 'profile', 'w_member_social']);
  assert.equal(url.searchParams.get('state'), 's2');
});

test('LinkedIn code exchange records expiry and an optional refresh token', async () => {
  const fetchImpl = fakeFetch(() => ({ json: { access_token: 'a', expires_in: 5184000 } }));
  const tokens = await linkedin.exchangeCode(fetchImpl, liApp, { code: 'c', redirectUri: 'u', now: NOW });
  assert.deepEqual(tokens, { accessToken: 'a', expiresAt: NOW + 5184000_000, refreshToken: null, refreshExpiresAt: null });
  const body = new URLSearchParams(fetchImpl.calls[0].body);
  assert.equal(body.get('client_secret'), 'li-secret-value');
  assert.equal(body.get('grant_type'), 'authorization_code');
});

test('LinkedIn account lookup builds the member URN', async () => {
  const fetchImpl = fakeFetch(() => ({ json: { sub: 'abc', name: 'Some One' } }));
  assert.deepEqual(await linkedin.getAccount(fetchImpl, 'tok'), { urn: 'urn:li:person:abc', name: 'Some One' });
});

test('LinkedIn image upload registers, sends the bytes, and returns the asset', async () => {
  const fetchImpl = fakeFetch((call) =>
    call.url.includes('registerUpload')
      ? { json: { value: { asset: 'urn:li:digitalmediaAsset:A1', uploadMechanism: { 'com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest': { uploadUrl: 'https://upload.example.test/put' } } } } }
      : { status: 201 },
  );
  const asset = await linkedin.uploadImage(fetchImpl, 'tok', 'urn:li:person:abc', Buffer.from('img'));
  assert.equal(asset, 'urn:li:digitalmediaAsset:A1');
  const [register, put] = fetchImpl.calls;
  assert.equal(JSON.parse(register.body).registerUploadRequest.owner, 'urn:li:person:abc');
  assert.equal(put.method, 'PUT');
  assert.equal(put.url, 'https://upload.example.test/put');
});

test('LinkedIn post body is a public member share, with the image when given', () => {
  const plain = linkedin.buildPostBody({ authorUrn: 'urn:li:person:abc', text: 'hello' });
  assert.equal(plain.specificContent['com.linkedin.ugc.ShareContent'].shareMediaCategory, 'NONE');
  assert.equal(plain.visibility['com.linkedin.ugc.MemberNetworkVisibility'], 'PUBLIC');
  const withImage = linkedin.buildPostBody({ authorUrn: 'urn:li:person:abc', text: 'hello', imageAsset: 'urn:li:digitalmediaAsset:A1' });
  const share = withImage.specificContent['com.linkedin.ugc.ShareContent'];
  assert.equal(share.shareMediaCategory, 'IMAGE');
  assert.deepEqual(share.media, [{ status: 'READY', media: 'urn:li:digitalmediaAsset:A1' }]);
});

test('LinkedIn post reads the new post id from the response header', async () => {
  const fetchImpl = fakeFetch(() => ({ status: 201, headers: { 'x-restli-id': 'urn:li:share:99' } }));
  const post = await linkedin.createPost(fetchImpl, 'tok', { authorUrn: 'urn:li:person:abc', text: 'hello' });
  assert.equal(post.id, 'urn:li:share:99');
  assert.equal(fetchImpl.calls[0].headers['x-restli-protocol-version'], '2.0.0');
  assert.equal(linkedin.postUrl(post.id), 'https://www.linkedin.com/feed/update/urn:li:share:99/');
});
