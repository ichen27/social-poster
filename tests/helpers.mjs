import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'social-poster-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

// A stand-in for fetch. `handler` receives each call and returns
// { status, json, text, headers } (all optional). Calls are recorded.
export function fakeFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const call = { url: String(url), method: init.method || 'GET', headers: init.headers || {}, body: init.body };
    calls.push(call);
    const reply = (await handler(call)) || {};
    const body = reply.json !== undefined ? JSON.stringify(reply.json) : reply.text || '';
    return new Response(body || null, { status: reply.status || 200, headers: reply.headers || {} });
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

export const CONFIG = { host: '127.0.0.1', port: 0, dataDir: '', publicUrl: 'https://poster.example.test' };

export const FUTURE = Date.parse('2030-01-01T00:00:00Z');
export const NOW = Date.parse('2026-11-15T12:00:00Z');

export function connected() {
  return {
    x: {
      clientId: 'x-client',
      clientSecret: 'x-secret-value',
      tokens: { accessToken: 'x-access-token', refreshToken: 'x-refresh-token', expiresAt: FUTURE },
      account: { id: '1', username: 'someone' },
    },
    linkedin: {
      clientId: 'li-client',
      clientSecret: 'li-secret-value',
      tokens: { accessToken: 'li-access-token', refreshToken: null, expiresAt: FUTURE },
      account: { urn: 'urn:li:person:abc', name: 'Some One' },
    },
  };
}

export async function seed(store, data) {
  for (const [platform, record] of Object.entries(data)) await store.update(platform, () => record);
}
