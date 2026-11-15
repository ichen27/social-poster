import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import * as x from './x.mjs';
import * as linkedin from './linkedin.mjs';
import { PLATFORMS, LABELS, describeConnections, freshXToken, freshLinkedInToken } from './connections.mjs';

export const X_TEXT_LIMIT = 280;
const X_URL_WEIGHT = 23;
const IMAGE_TYPES = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
const URL_PATTERN = /https?:\/\/[^\s]+/g;

// X counts every link as 23 characters and most non-Latin characters
// (emoji, CJK) as 2. This mirrors the published weighting closely enough to
// catch posts that would be rejected for length.
export function xWeightedLength(text) {
  let length = 0;
  const withoutUrls = text.normalize('NFC').replace(URL_PATTERN, () => {
    length += X_URL_WEIGHT;
    return '';
  });
  for (const character of withoutUrls) {
    const code = character.codePointAt(0);
    const single =
      code <= 4351 || (code >= 8192 && code <= 8205) || (code >= 8208 && code <= 8223) || (code >= 8242 && code <= 8247);
    length += single ? 1 : 2;
  }
  return length;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function withLink(text, link) {
  if (!link || text.includes(link)) return text;
  return `${text}\n\n${link}`;
}

export async function readDraft(draftPath) {
  let raw;
  try {
    raw = await fs.readFile(draftPath, 'utf8');
  } catch (error) {
    throw new Error(`Cannot read draft file ${draftPath}: ${error.code || error.message}`);
  }
  let draft;
  try {
    draft = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Draft file ${draftPath} is not valid JSON: ${error.message}`);
  }
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) {
    throw new Error('Draft must be a JSON object');
  }
  return { draft, baseDir: path.dirname(path.resolve(draftPath)) };
}

// Turn a draft into the exact text each platform would receive, plus every
// reason it cannot be published. Nothing here talks to X or LinkedIn.
export async function buildPlan({ draft, baseDir, store, allowDuplicate = false, allowLong = false, now = Date.now() }) {
  const problems = [];
  const requested = Array.isArray(draft.to) ? draft.to : [];
  if (!requested.length) problems.push('"to" must list at least one of: x, linkedin');
  for (const name of requested) {
    if (!PLATFORMS.includes(name)) problems.push(`Unknown platform "${name}" in "to" (use x or linkedin)`);
  }
  const platforms = PLATFORMS.filter((name) => requested.includes(name));

  if (draft.link !== undefined) {
    let parsed = null;
    try {
      parsed = new URL(draft.link);
    } catch {
      parsed = null;
    }
    if (!parsed || parsed.protocol !== 'https:') problems.push('"link" must be a full https:// URL');
  }

  let image = null;
  if (draft.image !== undefined) {
    if (typeof draft.image !== 'string' || !draft.image) {
      problems.push('"image" must be a file path');
    } else {
      const imagePath = path.resolve(baseDir, draft.image);
      const extension = path.extname(imagePath).toLowerCase();
      try {
        const bytes = await fs.readFile(imagePath);
        if (!IMAGE_TYPES.has(extension)) {
          problems.push(`Image must be PNG, JPG, GIF or WEBP, got "${extension || 'no extension'}"`);
        } else if (bytes.length > x.IMAGE_LIMIT_BYTES) {
          problems.push(`Image is ${(bytes.length / 1048576).toFixed(1)} MB; the limit is 5 MB`);
        } else {
          image = { path: imagePath, bytes, hash: sha256(bytes), title: draft.imageTitle || null };
        }
      } catch (error) {
        problems.push(`Cannot read image ${imagePath}: ${error.code || error.message}`);
      }
    }
  }

  const data = await store.read();
  const connections = describeConnections(data, now);
  const history = await store.readHistory();

  const targets = [];
  for (const platform of platforms) {
    const own = draft[platform]?.text;
    const base = typeof own === 'string' ? own : draft.text;
    if (typeof base !== 'string' || !base.trim()) {
      problems.push(`No text for ${LABELS[platform]}: set "text" or "${platform}.text"`);
      continue;
    }
    const text = withLink(base.trim(), draft.link);
    const target = { platform, text, alreadyPosted: null };

    if (platform === 'x') {
      target.length = xWeightedLength(text);
      target.limit = X_TEXT_LIMIT;
      if (target.length > X_TEXT_LIMIT && !allowLong) {
        problems.push(`X text is ${target.length} of ${X_TEXT_LIMIT} characters (links count as 23). Shorten it, or pass --allow-long if the account can post long posts.`);
      }
    } else {
      target.length = [...text].length;
      target.limit = linkedin.TEXT_LIMIT;
      if (target.length > linkedin.TEXT_LIMIT) {
        problems.push(`LinkedIn text is ${target.length} of ${linkedin.TEXT_LIMIT} characters`);
      }
    }

    target.contentHash = sha256(JSON.stringify([platform, text, image?.hash || null]));
    const earlier = history.find((entry) => entry.platform === platform && entry.contentHash === target.contentHash);
    if (earlier && !allowDuplicate) target.alreadyPosted = { url: earlier.url, at: earlier.at };

    if (!connections[platform].connected) {
      problems.push(`${LABELS[platform]} is not connected${connections[platform].note ? ` (${connections[platform].note})` : ''}`);
    }
    targets.push(target);
  }

  // The code ties an approval to this exact content: any edit changes it.
  const confirmCode = sha256(JSON.stringify(targets.map((t) => [t.platform, t.text, image?.hash || null]))).slice(0, 8);
  return { targets, image, problems, confirmCode, connections };
}

export function formatPlan(plan) {
  const lines = [];
  for (const target of plan.targets) {
    const account = plan.connections[target.platform].account;
    lines.push(`=== ${LABELS[target.platform]}${account ? ` (${account})` : ''} — ${target.length}/${target.limit} characters ===`);
    lines.push(target.text);
    if (target.alreadyPosted) {
      lines.push(`[Already posted ${target.alreadyPosted.at}: ${target.alreadyPosted.url} — will be skipped]`);
    }
    lines.push('');
  }
  lines.push(plan.image ? `Image: ${plan.image.path} (${(plan.image.bytes.length / 1024).toFixed(0)} KB)` : 'Image: none');
  if (plan.problems.length) {
    lines.push('', 'Cannot publish yet:');
    for (const problem of plan.problems) lines.push(`  - ${problem}`);
  } else {
    lines.push('', `Ready. Confirmation code: ${plan.confirmCode}`);
  }
  return lines.join('\n');
}

async function publishToX(target, plan, deps) {
  const { accessToken, account } = await freshXToken(deps);
  const mediaIds = plan.image ? [await x.uploadImage(deps.fetchImpl, accessToken, plan.image.bytes)] : [];
  const { id } = await x.createPost(deps.fetchImpl, accessToken, { text: target.text, mediaIds });
  return { id, url: x.postUrl(account?.username, id) };
}

async function publishToLinkedIn(target, plan, deps) {
  const { accessToken, account } = await freshLinkedInToken(deps);
  const imageAsset = plan.image
    ? await linkedin.uploadImage(deps.fetchImpl, accessToken, account.urn, plan.image.bytes)
    : null;
  const { id } = await linkedin.createPost(deps.fetchImpl, accessToken, {
    authorUrn: account.urn,
    text: target.text,
    imageAsset,
    imageTitle: plan.image?.title,
  });
  return { id, url: linkedin.postUrl(id) };
}

// Publish each target independently so one platform failing does not hide the
// other's result. Successes are recorded, which makes a retry skip them.
export async function publish(plan, deps) {
  if (plan.problems.length) throw new Error('Draft has problems; run preview and fix them first');
  const now = deps.now ?? Date.now();
  const results = [];
  for (const target of plan.targets) {
    if (target.alreadyPosted) {
      results.push({ platform: target.platform, status: 'skipped', url: target.alreadyPosted.url });
      continue;
    }
    try {
      const sender = target.platform === 'x' ? publishToX : publishToLinkedIn;
      const { id, url } = await sender(target, plan, { ...deps, now });
      await deps.store.appendHistory({
        at: new Date(now).toISOString(),
        platform: target.platform,
        id,
        url,
        contentHash: target.contentHash,
      });
      results.push({ platform: target.platform, status: 'posted', url });
    } catch (error) {
      results.push({ platform: target.platform, status: 'failed', error: error.message });
    }
  }
  return results;
}
