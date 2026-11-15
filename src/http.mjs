// Shared helper for calling the platform APIs. Errors carry the HTTP status
// and the platform's own message, and never include request headers or bodies,
// so tokens and secrets cannot leak into logs.
export class ApiError extends Error {
  constructor(platform, action, status, detail) {
    super(`${platform} ${action} failed (HTTP ${status})${detail ? `: ${detail}` : ''}`);
    this.name = 'ApiError';
    this.platform = platform;
    this.action = action;
    this.status = status;
  }
}

export async function callApi(fetchImpl, { platform, action, url, init, expectJson = true }) {
  let response;
  try {
    response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(30_000) });
  } catch (error) {
    throw new Error(`${platform} ${action} could not reach the server: ${error.message}`);
  }
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  if (!response.ok) {
    throw new ApiError(platform, action, response.status, describeError(body, text));
  }
  if (expectJson && body === null) {
    throw new Error(`${platform} ${action} returned a response that is not JSON`);
  }
  return { body, headers: response.headers };
}

function describeError(body, text) {
  if (body && typeof body === 'object') {
    const parts = [
      body.detail,
      body.title,
      body.message,
      body.error_description,
      body.error,
      ...(Array.isArray(body.errors) ? body.errors.map((e) => e?.detail || e?.message) : []),
    ].filter((part) => typeof part === 'string' && part);
    if (parts.length) return [...new Set(parts)].join('; ').slice(0, 400);
  }
  return (text || '').replace(/\s+/g, ' ').slice(0, 200);
}

export function formBody(fields) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && value !== null) params.set(key, value);
  }
  return params.toString();
}
