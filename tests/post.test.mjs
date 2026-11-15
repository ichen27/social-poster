import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createStore } from '../src/store.mjs';
import { xWeightedLength, buildPlan, formatPlan, publish, readDraft } from '../src/post.mjs';
import { run } from '../src/cli.mjs';
import { tempDir, fakeFetch, connected, seed, CONFIG, NOW } from './helpers.mjs';

async function setup(t, data = connected()) {
  const dir = await tempDir(t);
  const store = createStore(path.join(dir, 'data'));
  await seed(store, data);
  return { dir, store };
}

// Answers every X and LinkedIn call a successful publish makes.
function platformFetch(overrides = {}) {
  return fakeFetch((call) => {
    for (const [fragment, reply] of Object.entries(overrides)) if (call.url.includes(fragment)) return reply;
    if (call.url.includes('/media/upload')) return { json: { data: { id: 'm1' } } };
    if (call.url.endsWith('/2/tweets')) return { status: 201, json: { data: { id: 'p1' } } };
    if (call.url.includes('registerUpload')) {
      return { json: { value: { asset: 'urn:li:digitalmediaAsset:A1', uploadMechanism: { 'com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest': { uploadUrl: 'https://upload.example.test/put' } } } } };
    }
    if (call.url.startsWith('https://upload.example.test')) return { status: 201 };
    if (call.url.endsWith('/ugcPosts')) return { status: 201, headers: { 'x-restli-id': 'urn:li:share:99' } };
    return { status: 500, text: `unexpected call ${call.url}` };
  });
}

test('X length counts a link as 23 and emoji as 2', () => {
  assert.equal(xWeightedLength('hello'), 5);
  assert.equal(xWeightedLength('see https://github.com/someone/a-very-long-repository-name-here'), 4 + 23);
  assert.equal(xWeightedLength('hi 🚀'), 3 + 2);
});

test('plan appends the link once and gives each platform its own text', async (t) => {
  const { dir, store } = await setup(t);
  const draft = { to: ['linkedin', 'x'], text: 'Shared words', x: { text: 'Short take https://github.com/a/b' }, link: 'https://github.com/a/b' };
  const plan = await buildPlan({ draft, baseDir: dir, store, now: NOW });
  assert.deepEqual(plan.problems, []);
  assert.deepEqual(plan.targets.map((target) => target.platform), ['x', 'linkedin']);
  assert.equal(plan.targets[0].text, 'Short take https://github.com/a/b');
  assert.equal(plan.targets[1].text, 'Shared words\n\nhttps://github.com/a/b');
  assert.match(plan.confirmCode, /^[0-9a-f]{8}$/);
});

test('plan lists every problem that blocks publishing', async (t) => {
  const { dir, store } = await setup(t, { x: { clientId: 'only-app-details' } });
  const draft = { to: ['x', 'mastodon'], text: 'a'.repeat(300), link: 'http://insecure.example', image: 'missing.png' };
  const plan = await buildPlan({ draft, baseDir: dir, store, now: NOW });
  const all = plan.problems.join('\n');
  assert.match(all, /Unknown platform "mastodon"/);
  assert.match(all, /"link" must be a full https/);
  assert.match(all, /Cannot read image/);
  assert.match(all, /X text is \d+ of 280/);
  assert.match(all, /X is not connected/);
  assert.doesNotMatch(formatPlan(plan), /Confirmation code/);
});

test('plan rejects a draft with no targets or no text', async (t) => {
  const { dir, store } = await setup(t);
  assert.match((await buildPlan({ draft: {}, baseDir: dir, store, now: NOW })).problems.join('\n'), /"to" must list/);
  assert.match((await buildPlan({ draft: { to: ['x'], text: '  ' }, baseDir: dir, store, now: NOW })).problems.join('\n'), /No text for X/);
});

test('plan rejects an oversized or wrong-type image', async (t) => {
  const { dir, store } = await setup(t);
  await fs.writeFile(path.join(dir, 'big.png'), Buffer.alloc(5 * 1024 * 1024 + 1));
  await fs.writeFile(path.join(dir, 'clip.mp4'), 'x');
  const big = await buildPlan({ draft: { to: ['x'], text: 'hi', image: 'big.png' }, baseDir: dir, store, now: NOW });
  assert.match(big.problems.join('\n'), /limit is 5 MB/);
  const video = await buildPlan({ draft: { to: ['x'], text: 'hi', image: 'clip.mp4' }, baseDir: dir, store, now: NOW });
  assert.match(video.problems.join('\n'), /PNG, JPG, GIF or WEBP/);
});

test('--allow-long lifts only the X length limit', async (t) => {
  const { dir, store } = await setup(t);
  const draft = { to: ['x', 'linkedin'], text: 'a'.repeat(3001) };
  const plan = await buildPlan({ draft, baseDir: dir, store, allowLong: true, now: NOW });
  assert.equal(plan.problems.length, 1);
  assert.match(plan.problems[0], /LinkedIn text is 3001 of 3000/);
});

test('an expired LinkedIn sign-in blocks the plan and says to connect again', async (t) => {
  const data = connected();
  data.linkedin.tokens.expiresAt = NOW - 1000;
  const { dir, store } = await setup(t, data);
  const plan = await buildPlan({ draft: { to: ['linkedin'], text: 'hi' }, baseDir: dir, store, now: NOW });
  assert.match(plan.problems.join('\n'), /LinkedIn is not connected \(Sign-in expired; connect again\.\)/);
});

test('the confirmation code changes when the text or the image changes', async (t) => {
  const { dir, store } = await setup(t);
  await fs.writeFile(path.join(dir, 'a.png'), 'one');
  const code = async (draft) => (await buildPlan({ draft, baseDir: dir, store, now: NOW })).confirmCode;
  const base = await code({ to: ['x'], text: 'hello', image: 'a.png' });
  assert.equal(base, await code({ to: ['x'], text: 'hello', image: 'a.png' }));
  assert.notEqual(base, await code({ to: ['x'], text: 'hello!', image: 'a.png' }));
  assert.notEqual(base, await code({ to: ['x', 'linkedin'], text: 'hello', image: 'a.png' }));
  await fs.writeFile(path.join(dir, 'a.png'), 'two');
  assert.notEqual(base, await code({ to: ['x'], text: 'hello', image: 'a.png' }));
});

test('publish uploads the image, posts to both platforms and records history', async (t) => {
  const { dir, store } = await setup(t);
  await fs.writeFile(path.join(dir, 'shot.png'), 'png-bytes');
  const plan = await buildPlan({ draft: { to: ['x', 'linkedin'], text: 'Launch', image: 'shot.png' }, baseDir: dir, store, now: NOW });
  const fetchImpl = platformFetch();
  const results = await publish(plan, { store, fetchImpl, config: CONFIG, now: NOW });
  assert.deepEqual(results, [
    { platform: 'x', status: 'posted', url: 'https://x.com/someone/status/p1' },
    { platform: 'linkedin', status: 'posted', url: 'https://www.linkedin.com/feed/update/urn:li:share:99/' },
  ]);
  const tweet = fetchImpl.calls.find((call) => call.url.endsWith('/2/tweets'));
  assert.deepEqual(JSON.parse(tweet.body), { text: 'Launch', media: { media_ids: ['m1'] } });
  const share = JSON.parse(fetchImpl.calls.find((call) => call.url.endsWith('/ugcPosts')).body);
  assert.equal(share.author, 'urn:li:person:abc');
  assert.equal(share.specificContent['com.linkedin.ugc.ShareContent'].media[0].media, 'urn:li:digitalmediaAsset:A1');
  assert.deepEqual((await store.readHistory()).map((entry) => entry.platform), ['x', 'linkedin']);
});

test('one platform failing does not stop the other, and a retry skips what already posted', async (t) => {
  const { dir, store } = await setup(t);
  const draft = { to: ['x', 'linkedin'], text: 'Launch' };
  const failing = platformFetch({ '/ugcPosts': { status: 500, json: { message: 'Internal error' } } });
  const first = await publish(await buildPlan({ draft, baseDir: dir, store, now: NOW }), { store, fetchImpl: failing, config: CONFIG, now: NOW });
  assert.equal(first[0].status, 'posted');
  assert.equal(first[1].status, 'failed');
  assert.match(first[1].error, /LinkedIn post failed \(HTTP 500\): Internal error/);

  const retryPlan = await buildPlan({ draft, baseDir: dir, store, now: NOW });
  assert.match(formatPlan(retryPlan), /Already posted/);
  const working = platformFetch();
  const second = await publish(retryPlan, { store, fetchImpl: working, config: CONFIG, now: NOW });
  assert.deepEqual(second.map((result) => result.status), ['skipped', 'posted']);
  assert.equal(working.calls.filter((call) => call.url.endsWith('/2/tweets')).length, 0);
});

test('--allow-duplicate posts the same content again', async (t) => {
  const { dir, store } = await setup(t);
  const draft = { to: ['x'], text: 'Again' };
  await publish(await buildPlan({ draft, baseDir: dir, store, now: NOW }), { store, fetchImpl: platformFetch(), config: CONFIG, now: NOW });
  const again = await buildPlan({ draft, baseDir: dir, store, allowDuplicate: true, now: NOW });
  assert.equal(again.targets[0].alreadyPosted, null);
});

test('publish renews an expiring X sign-in and saves the rotated token before posting', async (t) => {
  const data = connected();
  data.x.tokens.expiresAt = NOW + 1000;
  const { dir, store } = await setup(t, data);
  const fetchImpl = platformFetch({ '/oauth2/token': { json: { access_token: 'x-new-access', refresh_token: 'x-new-refresh', expires_in: 7200 } } });
  const plan = await buildPlan({ draft: { to: ['x'], text: 'hi' }, baseDir: dir, store, now: NOW });
  const results = await publish(plan, { store, fetchImpl, config: CONFIG, now: NOW });
  assert.equal(results[0].status, 'posted');
  assert.equal(fetchImpl.calls.find((call) => call.url.endsWith('/2/tweets')).headers.authorization, 'Bearer x-new-access');
  assert.equal((await store.read()).x.tokens.refreshToken, 'x-new-refresh');
});

test('a failed X renewal tells the user where to connect again', async (t) => {
  const data = connected();
  data.x.tokens.expiresAt = NOW + 1000;
  const { dir, store } = await setup(t, data);
  const fetchImpl = platformFetch({ '/oauth2/token': { status: 400, json: { error: 'invalid_request', error_description: 'Value passed for the token was invalid.' } } });
  const plan = await buildPlan({ draft: { to: ['x'], text: 'hi' }, baseDir: dir, store, now: NOW });
  const [result] = await publish(plan, { store, fetchImpl, config: CONFIG, now: NOW });
  assert.equal(result.status, 'failed');
  assert.match(result.error, /Open https:\/\/poster\.example\.test and connect X again/);
  assert.deepEqual(await store.readHistory(), []);
});

test('publish refuses a plan that still has problems', async (t) => {
  const { dir, store } = await setup(t);
  const plan = await buildPlan({ draft: { to: ['x'] }, baseDir: dir, store, now: NOW });
  await assert.rejects(publish(plan, { store, fetchImpl: platformFetch(), config: CONFIG, now: NOW }), /has problems/);
});

test('readDraft explains a missing or malformed draft', async (t) => {
  const dir = await tempDir(t);
  await assert.rejects(readDraft(path.join(dir, 'nope.json')), /Cannot read draft file/);
  await fs.writeFile(path.join(dir, 'bad.json'), '{');
  await assert.rejects(readDraft(path.join(dir, 'bad.json')), /not valid JSON/);
  await fs.writeFile(path.join(dir, 'list.json'), '[]');
  await assert.rejects(readDraft(path.join(dir, 'list.json')), /must be a JSON object/);
});

// --- command line ---

async function cli(t, args, { data = connected(), fetchImpl = platformFetch(), draft } = {}) {
  const { dir, store } = await setup(t, data);
  const draftPath = path.join(dir, 'draft.json');
  if (draft) await fs.writeFile(draftPath, JSON.stringify(draft));
  const out = [];
  const err = [];
  const code = await run(args.map((arg) => (arg === 'DRAFT' ? draftPath : arg)), {
    env: { SOCIAL_POSTER_DATA_DIR: path.join(dir, 'data'), PUBLIC_URL: CONFIG.publicUrl },
    fetchImpl,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    now: NOW,
  });
  return { code, out: out.join('\n'), err: err.join('\n'), fetchImpl, store, dir, draftPath };
}

test('status reports connections without printing any secret or token', async (t) => {
  const { code, out } = await cli(t, ['status']);
  assert.equal(code, 0);
  assert.match(out, /X: connected as someone/);
  assert.match(out, /LinkedIn: connected as Some One/);
  for (const secret of ['x-secret-value', 'x-access-token', 'x-refresh-token', 'li-secret-value', 'li-access-token']) {
    assert.ok(!out.includes(secret), secret);
  }
  const json = await cli(t, ['status', '--json']);
  assert.equal(JSON.parse(json.out).x.connected, true);
  assert.ok(!json.out.includes('x-access-token'));
});

test('preview shows the text and a code and contacts no platform', async (t) => {
  const { code, out, fetchImpl } = await cli(t, ['preview', 'DRAFT'], { draft: { to: ['x'], text: 'Hello world' } });
  assert.equal(code, 0);
  assert.match(out, /=== X \(someone\) — 11\/280 characters ===\nHello world/);
  assert.match(out, /Confirmation code: [0-9a-f]{8}/);
  assert.equal(fetchImpl.calls.length, 0);
});

test('publish without a code, or with a stale code, posts nothing', async (t) => {
  const missing = await cli(t, ['publish', 'DRAFT'], { draft: { to: ['x'], text: 'Hello world' } });
  assert.equal(missing.code, 1);
  assert.match(missing.err, /Nothing was posted/);
  assert.equal(missing.fetchImpl.calls.length, 0);

  const stale = await cli(t, ['publish', 'DRAFT', '--confirm', 'deadbeef'], { draft: { to: ['x'], text: 'Hello world' } });
  assert.equal(stale.code, 1);
  assert.match(stale.err, /does not match this draft/);
  assert.equal(stale.fetchImpl.calls.length, 0);
});

test('publish with the previewed code posts and prints the post link', async (t) => {
  const draft = { to: ['x'], text: 'Hello world' };
  const preview = await cli(t, ['preview', 'DRAFT'], { draft });
  const confirm = preview.out.match(/Confirmation code: ([0-9a-f]{8})/)[1];
  const result = await cli(t, ['publish', 'DRAFT', '--confirm', confirm], { draft });
  assert.equal(result.code, 0);
  assert.match(result.out, /X: posted https:\/\/x\.com\/someone\/status\/p1/);
});

test('publish exits non-zero and names the platform when a post fails', async (t) => {
  const draft = { to: ['x'], text: 'Hello world' };
  const confirm = (await cli(t, ['preview', 'DRAFT'], { draft })).out.match(/code: ([0-9a-f]{8})/)[1];
  const fetchImpl = platformFetch({ '/2/tweets': { status: 402, json: { title: 'CreditsDepleted', detail: 'Your account has no credits.' } } });
  const result = await cli(t, ['publish', 'DRAFT', '--confirm', confirm], { draft, fetchImpl });
  assert.equal(result.code, 1);
  assert.match(result.err, /X: FAILED — X post failed \(HTTP 402\): Your account has no credits\./);
});

test('unknown commands and options are rejected with usage', async (t) => {
  assert.equal((await cli(t, ['frobnicate'])).code, 2);
  assert.equal((await cli(t, ['preview', 'DRAFT', '--force'], { draft: { to: ['x'], text: 'hi' } })).code, 2);
  assert.equal((await cli(t, [])).code, 2);
  assert.equal((await cli(t, ['publish'])).code, 2);
});

test('the command runs when started through a symlink', async (t) => {
  const { execFile } = await import('node:child_process');
  const dir = await tempDir(t);
  const link = path.join(dir, 'social-poster');
  await fs.symlink(path.resolve('src/cli.mjs'), link);
  const result = await new Promise((resolve) => {
    execFile(process.execPath, [link, 'status'], { env: { ...process.env, SOCIAL_POSTER_DATA_DIR: path.join(dir, 'data') } }, (error, stdout, stderr) =>
      resolve({ code: error?.code ?? 0, stdout, stderr }),
    );
  });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /X: app details not saved/);
});
