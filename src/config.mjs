import path from 'node:path';

// All settings come from the environment so the server (started by a process
// manager) and the CLI (started with `node --env-file=...`) read one source.
export function loadConfig(env = process.env) {
  const port = Number(env.PORT || 8945);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be a whole number from 1 to 65535, got "${env.PORT}"`);
  }
  const host = env.HOST || '127.0.0.1';
  const dataDir = path.resolve(env.SOCIAL_POSTER_DATA_DIR || env.APP_DATA_DIR || 'data');
  const publicUrl = normalizePublicUrl(env.PUBLIC_URL || `http://127.0.0.1:${port}`);
  return { host, port, dataDir, publicUrl };
}

function normalizePublicUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`PUBLIC_URL is not a valid URL: "${value}"`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('PUBLIC_URL must start with http:// or https://');
  }
  return url.origin;
}

export function callbackUrl(config, platform) {
  return `${config.publicUrl}/auth/${platform}/callback`;
}
