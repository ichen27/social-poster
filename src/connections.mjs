import * as x from './x.mjs';
import * as linkedin from './linkedin.mjs';

export const PLATFORMS = ['x', 'linkedin'];
export const LABELS = { x: 'X', linkedin: 'LinkedIn' };
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
const EXPIRY_WARNING_MS = 7 * 24 * 60 * 60 * 1000;

// A summary that is safe to print or render: it never includes a token or secret.
export function describeConnections(data, now = Date.now()) {
  const summary = {};
  for (const platform of PLATFORMS) {
    const record = data[platform] || {};
    const tokens = record.tokens || null;
    const entry = {
      appSaved: Boolean(record.clientId),
      connected: Boolean(tokens?.accessToken),
      account: record.account?.username || record.account?.name || null,
      expiresAt: null,
      note: null,
    };
    if (entry.connected) {
      // For X the access token is short-lived and renewed automatically, so the
      // date that matters is when you must sign in again.
      const canRefresh = Boolean(tokens.refreshToken) && (!tokens.refreshExpiresAt || tokens.refreshExpiresAt > now);
      const signInAgainAt = canRefresh ? tokens.refreshExpiresAt || null : tokens.expiresAt;
      entry.expiresAt = signInAgainAt;
      if (signInAgainAt && signInAgainAt <= now) {
        entry.connected = false;
        entry.note = 'Sign-in expired; connect again.';
      } else if (signInAgainAt && signInAgainAt - now < EXPIRY_WARNING_MS) {
        entry.note = `Sign-in expires on ${new Date(signInAgainAt).toISOString().slice(0, 10)}; connect again before then.`;
      }
    }
    summary[platform] = entry;
  }
  return summary;
}

function reconnectMessage(platform, config, reason) {
  return `${LABELS[platform]} ${reason}. Open ${config.publicUrl} and connect ${LABELS[platform]} again.`;
}

// Return a usable X access token, renewing it when it is close to expiring.
export async function freshXToken({ store, fetchImpl, config, now = Date.now() }) {
  const record = (await store.read()).x || {};
  const tokens = record.tokens;
  if (!tokens?.accessToken) throw new Error(reconnectMessage('x', config, 'is not connected'));
  if (tokens.expiresAt - now > REFRESH_MARGIN_MS) return { accessToken: tokens.accessToken, account: record.account };
  if (!tokens.refreshToken) throw new Error(reconnectMessage('x', config, 'sign-in has expired'));
  let renewed;
  try {
    renewed = await x.refreshTokens(fetchImpl, record, tokens.refreshToken, now);
  } catch (error) {
    throw new Error(`${reconnectMessage('x', config, 'sign-in could not be renewed')} (${error.message})`);
  }
  // Save before use: X invalidates the old refresh token once it is exchanged.
  await store.update('x', (current) => ({ ...current, tokens: renewed }));
  return { accessToken: renewed.accessToken, account: record.account };
}

export async function freshLinkedInToken({ store, fetchImpl, config, now = Date.now() }) {
  const record = (await store.read()).linkedin || {};
  const tokens = record.tokens;
  if (!tokens?.accessToken) throw new Error(reconnectMessage('linkedin', config, 'is not connected'));
  if (!record.account?.urn) throw new Error(reconnectMessage('linkedin', config, 'has no member id saved'));
  if (tokens.expiresAt - now > REFRESH_MARGIN_MS) return { accessToken: tokens.accessToken, account: record.account };
  const canRefresh = tokens.refreshToken && (!tokens.refreshExpiresAt || tokens.refreshExpiresAt > now);
  if (!canRefresh) throw new Error(reconnectMessage('linkedin', config, 'sign-in has expired'));
  let renewed;
  try {
    renewed = await linkedin.refreshTokens(fetchImpl, record, tokens, now);
  } catch (error) {
    throw new Error(`${reconnectMessage('linkedin', config, 'sign-in could not be renewed')} (${error.message})`);
  }
  await store.update('linkedin', (current) => ({ ...current, tokens: renewed }));
  return { accessToken: renewed.accessToken, account: record.account };
}
