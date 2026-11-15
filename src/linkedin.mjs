import { callApi, formBody } from './http.mjs';

// LinkedIn "Share on LinkedIn" (self-serve) with 3-legged OAuth.
// Docs: https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/share-on-linkedin
const AUTHORIZE_URL = 'https://www.linkedin.com/oauth/v2/authorization';
const TOKEN_URL = 'https://www.linkedin.com/oauth/v2/accessToken';
const API = 'https://api.linkedin.com/v2';
// openid + profile let us read the member id that posts are attributed to.
export const SCOPES = ['openid', 'profile', 'w_member_social'];
export const TEXT_LIMIT = 3000;
const PLATFORM = 'LinkedIn';

export function buildAuthUrl({ clientId, redirectUri, state }) {
  const url = new URL(AUTHORIZE_URL);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
    scope: SCOPES.join(' '),
  }).toString();
  return url.toString();
}

function toTokens(body, now) {
  if (!body.access_token) throw new Error('LinkedIn did not return an access token');
  return {
    accessToken: body.access_token,
    expiresAt: now + Number(body.expires_in || 0) * 1000,
    // Refresh tokens are only issued to some LinkedIn apps.
    refreshToken: body.refresh_token || null,
    refreshExpiresAt: body.refresh_token_expires_in ? now + Number(body.refresh_token_expires_in) * 1000 : null,
  };
}

function tokenRequest(fields) {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: formBody(fields),
  };
}

export async function exchangeCode(fetchImpl, app, { code, redirectUri, now = Date.now() }) {
  const { body } = await callApi(fetchImpl, {
    platform: PLATFORM,
    action: 'sign-in',
    url: TOKEN_URL,
    init: tokenRequest({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: app.clientId,
      client_secret: app.clientSecret,
    }),
  });
  return toTokens(body, now);
}

export async function refreshTokens(fetchImpl, app, tokens, now = Date.now()) {
  const { body } = await callApi(fetchImpl, {
    platform: PLATFORM,
    action: 'token refresh',
    url: TOKEN_URL,
    init: tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: tokens.refreshToken,
      client_id: app.clientId,
      client_secret: app.clientSecret,
    }),
  });
  const fresh = toTokens(body, now);
  if (!fresh.refreshToken) {
    fresh.refreshToken = tokens.refreshToken;
    fresh.refreshExpiresAt = tokens.refreshExpiresAt;
  }
  return fresh;
}

function headers(accessToken, extra = {}) {
  return { authorization: `Bearer ${accessToken}`, 'x-restli-protocol-version': '2.0.0', ...extra };
}

export async function getAccount(fetchImpl, accessToken) {
  const { body } = await callApi(fetchImpl, {
    platform: PLATFORM,
    action: 'account lookup',
    url: `${API}/userinfo`,
    init: { headers: headers(accessToken) },
  });
  if (!body.sub) throw new Error('LinkedIn did not return a member id');
  return { urn: `urn:li:person:${body.sub}`, name: body.name || null };
}

// Two steps: register the upload to get a one-time URL, then send the bytes.
export async function uploadImage(fetchImpl, accessToken, ownerUrn, bytes) {
  const { body } = await callApi(fetchImpl, {
    platform: PLATFORM,
    action: 'image registration',
    url: `${API}/assets?action=registerUpload`,
    init: {
      method: 'POST',
      headers: headers(accessToken, { 'content-type': 'application/json' }),
      body: JSON.stringify({
        registerUploadRequest: {
          recipes: ['urn:li:digitalmediaRecipe:feedshare-image'],
          owner: ownerUrn,
          serviceRelationships: [{ relationshipType: 'OWNER', identifier: 'urn:li:userGeneratedContent' }],
        },
      }),
    },
  });
  const upload = body.value?.uploadMechanism?.['com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest'];
  const asset = body.value?.asset;
  if (!upload?.uploadUrl || !asset) throw new Error('LinkedIn image registration returned no upload URL');
  await callApi(fetchImpl, {
    platform: PLATFORM,
    action: 'image upload',
    url: upload.uploadUrl,
    init: {
      method: 'PUT',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/octet-stream' },
      body: bytes,
    },
    expectJson: false,
  });
  return asset;
}

export function buildPostBody({ authorUrn, text, imageAsset, imageTitle }) {
  const share = { shareCommentary: { text }, shareMediaCategory: 'NONE' };
  if (imageAsset) {
    share.shareMediaCategory = 'IMAGE';
    const media = { status: 'READY', media: imageAsset };
    if (imageTitle) media.title = { text: imageTitle };
    share.media = [media];
  }
  return {
    author: authorUrn,
    lifecycleState: 'PUBLISHED',
    specificContent: { 'com.linkedin.ugc.ShareContent': share },
    visibility: { 'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC' },
  };
}

export async function createPost(fetchImpl, accessToken, post) {
  const { body, headers: responseHeaders } = await callApi(fetchImpl, {
    platform: PLATFORM,
    action: 'post',
    url: `${API}/ugcPosts`,
    init: {
      method: 'POST',
      headers: headers(accessToken, { 'content-type': 'application/json' }),
      body: JSON.stringify(buildPostBody(post)),
    },
    expectJson: false,
  });
  const id = responseHeaders.get('x-restli-id') || body?.id;
  if (!id) throw new Error('LinkedIn accepted the post but returned no id');
  return { id };
}

export function postUrl(id) {
  return `https://www.linkedin.com/feed/update/${id}/`;
}
