import crypto from 'node:crypto';
import { callApi, formBody } from './http.mjs';

// X API v2 with OAuth 2.0 Authorization Code + PKCE.
// Docs: https://docs.x.com/resources/fundamentals/authentication/oauth-2-0/authorization-code
const AUTHORIZE_URL = 'https://x.com/i/oauth2/authorize';
const TOKEN_URL = 'https://api.x.com/2/oauth2/token';
const API = 'https://api.x.com/2';
// offline.access is what makes X issue a refresh token.
export const SCOPES = ['tweet.read', 'tweet.write', 'users.read', 'media.write', 'offline.access'];
export const IMAGE_LIMIT_BYTES = 5 * 1024 * 1024;
const PLATFORM = 'X';

export function createPkce() {
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function buildAuthUrl({ clientId, redirectUri, state, challenge }) {
  const url = new URL(AUTHORIZE_URL);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: SCOPES.join(' '),
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString();
  return url.toString();
}

// Confidential clients (those with a secret) authenticate with a Basic header;
// public clients send client_id in the body instead.
function tokenRequest(app, fields) {
  const headers = { 'content-type': 'application/x-www-form-urlencoded' };
  const body = { ...fields };
  if (app.clientSecret) {
    const basic = Buffer.from(`${app.clientId}:${app.clientSecret}`);
    headers.authorization = `Basic ${basic.toString('base64')}`;
  } else {
    body.client_id = app.clientId;
  }
  return { method: 'POST', headers, body: formBody(body) };
}

function toTokens(body, now) {
  if (!body.access_token) throw new Error('X did not return an access token');
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token || null,
    expiresAt: now + Number(body.expires_in || 7200) * 1000,
    scope: body.scope || '',
  };
}

export async function exchangeCode(fetchImpl, app, { code, redirectUri, verifier, now = Date.now() }) {
  const { body } = await callApi(fetchImpl, {
    platform: PLATFORM,
    action: 'sign-in',
    url: TOKEN_URL,
    init: tokenRequest(app, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
  });
  return toTokens(body, now);
}

export async function refreshTokens(fetchImpl, app, refreshToken, now = Date.now()) {
  const { body } = await callApi(fetchImpl, {
    platform: PLATFORM,
    action: 'token refresh',
    url: TOKEN_URL,
    init: tokenRequest(app, { grant_type: 'refresh_token', refresh_token: refreshToken }),
  });
  const tokens = toTokens(body, now);
  // X rotates refresh tokens; keep the old one only if no new one came back.
  if (!tokens.refreshToken) tokens.refreshToken = refreshToken;
  return tokens;
}

function bearer(accessToken, extra = {}) {
  return { authorization: `Bearer ${accessToken}`, ...extra };
}

export async function getAccount(fetchImpl, accessToken) {
  const { body } = await callApi(fetchImpl, {
    platform: PLATFORM,
    action: 'account lookup',
    url: `${API}/users/me`,
    init: { headers: bearer(accessToken) },
  });
  return { id: body.data?.id || null, username: body.data?.username || null };
}

// Single-request upload, for images up to 5 MB. Video needs the chunked flow,
// which this tool does not implement.
export async function uploadImage(fetchImpl, accessToken, bytes) {
  const { body } = await callApi(fetchImpl, {
    platform: PLATFORM,
    action: 'image upload',
    url: `${API}/media/upload`,
    init: {
      method: 'POST',
      headers: bearer(accessToken, { 'content-type': 'application/json' }),
      body: JSON.stringify({ media: Buffer.from(bytes).toString('base64'), media_category: 'tweet_image' }),
    },
  });
  const id = body.data?.id;
  if (!id) throw new Error('X image upload returned no media id');
  return id;
}

export async function createPost(fetchImpl, accessToken, { text, mediaIds = [] }) {
  const payload = { text };
  if (mediaIds.length) payload.media = { media_ids: mediaIds };
  const { body } = await callApi(fetchImpl, {
    platform: PLATFORM,
    action: 'post',
    url: `${API}/tweets`,
    init: {
      method: 'POST',
      headers: bearer(accessToken, { 'content-type': 'application/json' }),
      body: JSON.stringify(payload),
    },
  });
  const id = body.data?.id;
  if (!id) throw new Error('X accepted the post but returned no id');
  return { id };
}

export function postUrl(username, id) {
  return `https://x.com/${username || 'i'}/status/${id}`;
}
