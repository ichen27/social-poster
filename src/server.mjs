import http from 'node:http';
import crypto from 'node:crypto';
import * as x from './x.mjs';
import * as linkedin from './linkedin.mjs';
import { callbackUrl } from './config.mjs';
import { PLATFORMS, LABELS, describeConnections } from './connections.mjs';

// The connect service: a small page for saving each platform's app
// credentials and signing in. It never displays a saved secret or token, and
// it never posts anything. It is meant to sit behind an authenticating proxy
// and listen on loopback only.
const PENDING_TTL_MS = 10 * 60 * 1000;
const MAX_BODY_BYTES = 8 * 1024;
const DEVELOPER_LINKS = {
  x: 'https://console.x.com',
  linkedin: 'https://www.linkedin.com/developers/apps',
};

const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    ...headers,
  });
  res.end(body);
}

function redirect(res, location) {
  res.writeHead(302, { location, 'cache-control': 'no-store' });
  res.end();
}

async function readForm(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error('Form is too large'), { status: 413 });
    chunks.push(chunk);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

function page(title, content) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root{color-scheme:light dark;--bg:#f6f5f1;--card:#fff;--ink:#1c1b19;--muted:#6b6862;--line:#dddad2;--accent:#1f5f4a;--warn:#9a5b00;--bad:#a12a2a}
@media (prefers-color-scheme:dark){:root{--bg:#161614;--card:#1f1f1c;--ink:#eceae4;--muted:#a09c93;--line:#34332f;--accent:#7fd0b3;--warn:#e0aa55;--bad:#ef8a8a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,sans-serif}
main{max-width:720px;margin:0 auto;padding:32px 16px 64px}h1{font-size:1.5rem;margin:0 0 4px}h2{font-size:1.1rem;margin:0}
p{margin:8px 0}.muted{color:var(--muted);font-size:.9rem}.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:20px;margin-top:20px}
.row{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}.state{font-size:.85rem;font-weight:600}
.ok{color:var(--accent)}.warn{color:var(--warn)}.bad{color:var(--bad)}
label{display:block;font-size:.85rem;color:var(--muted);margin-top:12px}
input{width:100%;padding:9px 10px;margin-top:4px;border:1px solid var(--line);border-radius:8px;background:transparent;color:inherit;font:inherit}
button,.button{display:inline-block;margin-top:14px;padding:9px 16px;border:1px solid var(--accent);border-radius:8px;background:var(--accent);color:var(--bg);font:inherit;font-weight:600;cursor:pointer;text-decoration:none}
button.quiet{background:transparent;color:var(--ink);border-color:var(--line)}
code{display:block;padding:8px 10px;border:1px solid var(--line);border-radius:8px;font-size:.85rem;overflow-wrap:anywhere;user-select:all}
.actions{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-start}.actions form{margin:0}
.notice{border-left:4px solid var(--accent);padding:10px 14px;background:var(--card);border-radius:6px;margin-top:20px}.notice.bad{border-color:var(--bad)}
details{margin-top:14px}summary{cursor:pointer;color:var(--muted);font-size:.9rem}a{color:var(--accent)}ul{padding-left:20px;margin:8px 0}
</style></head><body><main>${content}</main></body></html>`;
}

function platformCard(platform, status, config) {
  const label = LABELS[platform];
  let state = '<span class="state bad">App details needed</span>';
  if (status.connected) state = `<span class="state ok">Connected${status.account ? ` as ${escapeHtml(status.account)}` : ''}</span>`;
  else if (status.appSaved) state = '<span class="state warn">Not connected</span>';

  const steps = platform === 'x'
    ? `<li>In the <a href="${DEVELOPER_LINKS.x}" target="_blank" rel="noopener">X developer console</a>, open your app's user authentication settings.</li>
       <li>Choose "Web App" (a confidential client) with read and write permission.</li>
       <li>Add the callback URL below, then copy the OAuth 2.0 Client ID and Client Secret here.</li>`
    : `<li>In <a href="${DEVELOPER_LINKS.linkedin}" target="_blank" rel="noopener">LinkedIn developer apps</a>, open your app.</li>
       <li>On the Products tab, add "Share on LinkedIn" and "Sign In with LinkedIn using OpenID Connect".</li>
       <li>On the Auth tab, add the redirect URL below, then copy the Client ID and Client Secret here.</li>`;

  const form = `<form method="post" action="/settings/${platform}">
      <label>Client ID<input name="clientId" autocomplete="off" required maxlength="200"></label>
      <label>Client Secret<input name="clientSecret" type="password" autocomplete="off" required maxlength="400"></label>
      <button type="submit" class="quiet">${status.appSaved ? 'Replace app details' : 'Save app details'}</button>
    </form>`;

  return `<section class="card">
    <div class="row"><h2>${label}</h2>${state}</div>
    ${status.note ? `<p class="warn">${escapeHtml(status.note)}</p>` : ''}
    ${status.connected && status.expiresAt ? `<p class="muted">Sign in again by ${escapeHtml(new Date(status.expiresAt).toISOString().slice(0, 10))}.</p>` : ''}
    <div class="actions">
      ${status.appSaved ? `<a class="button" href="/auth/${platform}/start">${status.connected ? 'Reconnect' : 'Connect'} ${label}</a>` : ''}
      ${status.connected ? `<form method="post" action="/disconnect/${platform}"><button type="submit" class="quiet">Disconnect</button></form>` : ''}
    </div>
    <details${status.appSaved ? '' : ' open'}><summary>App details</summary>
      <ul>${steps}</ul>
      <p class="muted">Callback / redirect URL</p><code>${escapeHtml(callbackUrl(config, platform))}</code>
      ${status.appSaved ? '<p class="muted">App details are saved. They are never shown again; saving new ones replaces them.</p>' : ''}
      ${form}
    </details>
  </section>`;
}

const NOTICES = {
  saved: 'App details saved.',
  connected: 'Connected.',
  disconnected: 'Disconnected. The saved sign-in was removed from this machine.',
};

export function createApp({ config, store, fetchImpl = fetch, now = () => Date.now(), randomState = () => crypto.randomBytes(24).toString('base64url') }) {
  const pending = new Map();

  function sameOrigin(req) {
    const origin = req.headers.origin;
    if (origin) return origin === config.publicUrl;
    return req.headers['sec-fetch-site'] === 'same-origin';
  }

  function fail(res, status, message) {
    send(res, status, page('Social Poster', `<h1>Social Poster</h1><div class="notice bad">${escapeHtml(message)}</div><p><a href="/">Back</a></p>`));
  }

  async function home(res, url) {
    const status = describeConnections(await store.read(), now());
    const history = (await store.readHistory()).slice(-5).reverse();
    const notice = NOTICES[url.searchParams.get('notice')];
    const cards = PLATFORMS.map((platform) => platformCard(platform, status[platform], config)).join('');
    const recent = history.length
      ? `<section class="card"><h2>Recent posts</h2><ul>${history
          .map((entry) => `<li>${escapeHtml(entry.at?.slice(0, 10) || '')} · ${escapeHtml(LABELS[entry.platform] || entry.platform)} · <a href="${escapeHtml(entry.url)}" target="_blank" rel="noopener">open</a></li>`)
          .join('')}</ul></section>`
      : '';
    send(res, 200, page('Social Poster', `<h1>Social Poster</h1>
      <p class="muted">Connect the accounts that posts are published to. Posts are previewed and published from the command line, never from this page.</p>
      ${notice ? `<div class="notice">${escapeHtml(notice)}</div>` : ''}${cards}${recent}`));
  }

  async function saveSettings(req, res, platform) {
    const form = await readForm(req);
    const clientId = (form.get('clientId') || '').trim();
    const clientSecret = (form.get('clientSecret') || '').trim();
    if (!clientId || !clientSecret || /\s/.test(clientId) || /\s/.test(clientSecret)) {
      return fail(res, 400, 'Enter both the Client ID and the Client Secret, without spaces.');
    }
    // New app details invalidate any sign-in made with the old ones.
    await store.update(platform, () => ({ clientId, clientSecret }));
    redirect(res, '/?notice=saved');
  }

  async function startAuth(res, platform) {
    const record = (await store.read())[platform] || {};
    if (!record.clientId) return fail(res, 400, `Save the ${LABELS[platform]} app details first.`);
    for (const [key, value] of pending) if (now() - value.createdAt > PENDING_TTL_MS) pending.delete(key);
    const state = randomState();
    const redirectUri = callbackUrl(config, platform);
    if (platform === 'x') {
      const { verifier, challenge } = x.createPkce();
      pending.set(state, { platform, verifier, createdAt: now() });
      return redirect(res, x.buildAuthUrl({ clientId: record.clientId, redirectUri, state, challenge }));
    }
    pending.set(state, { platform, createdAt: now() });
    redirect(res, linkedin.buildAuthUrl({ clientId: record.clientId, redirectUri, state }));
  }

  async function finishAuth(res, url, platform) {
    const state = url.searchParams.get('state') || '';
    const entry = pending.get(state);
    pending.delete(state);
    if (!entry || entry.platform !== platform || now() - entry.createdAt > PENDING_TTL_MS) {
      return fail(res, 400, 'This sign-in link is no longer valid. Start again from the Connect button.');
    }
    if (url.searchParams.get('error')) {
      return fail(res, 400, `${LABELS[platform]} did not approve the sign-in (${url.searchParams.get('error')}).`);
    }
    const code = url.searchParams.get('code');
    if (!code) return fail(res, 400, `${LABELS[platform]} returned no sign-in code.`);

    const record = (await store.read())[platform] || {};
    const redirectUri = callbackUrl(config, platform);
    const api = platform === 'x' ? x : linkedin;
    try {
      const tokens = await api.exchangeCode(fetchImpl, record, { code, redirectUri, verifier: entry.verifier, now: now() });
      const account = await api.getAccount(fetchImpl, tokens.accessToken);
      await store.update(platform, (current) => ({ ...current, tokens, account }));
    } catch (error) {
      console.error(`${LABELS[platform]} sign-in failed: ${error.message}`);
      return fail(res, 502, `${error.message}`);
    }
    redirect(res, '/?notice=connected');
  }

  async function disconnect(res, platform) {
    await store.update(platform, (current) => ({ clientId: current.clientId, clientSecret: current.clientSecret }));
    redirect(res, '/?notice=disconnected');
  }

  async function route(req, res) {
    const url = new URL(req.url, config.publicUrl);
    const parts = url.pathname.split('/').filter(Boolean);
    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return res.end('{"ok":true}');
    }
    if (req.method === 'GET' && url.pathname === '/') return home(res, url);

    const platform = parts[1];
    const known = PLATFORMS.includes(platform);
    if (req.method === 'GET' && parts[0] === 'auth' && known && parts.length === 3) {
      if (parts[2] === 'start') return startAuth(res, platform);
      if (parts[2] === 'callback') return finishAuth(res, url, platform);
    }
    if (req.method === 'POST' && known && parts.length === 2 && (parts[0] === 'settings' || parts[0] === 'disconnect')) {
      if (!sameOrigin(req)) return fail(res, 403, 'This request did not come from this page.');
      return parts[0] === 'settings' ? saveSettings(req, res, platform) : disconnect(res, platform);
    }
    fail(res, 404, 'Page not found.');
  }

  return http.createServer((req, res) => {
    route(req, res).catch((error) => {
      console.error(`Request failed: ${error.message}`);
      if (res.headersSent) return res.end();
      fail(res, error.status || 500, error.status ? error.message : 'Something went wrong. Check the service log.');
    });
  });
}
