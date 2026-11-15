import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createStore } from '../src/store.mjs';
import { loadConfig, callbackUrl } from '../src/config.mjs';
import { tempDir } from './helpers.mjs';

test('store returns an empty object before anything is saved', async (t) => {
  const store = createStore(path.join(await tempDir(t), 'nested'));
  assert.deepEqual(await store.read(), {});
  assert.deepEqual(await store.readHistory(), []);
});

test('store saves one platform without disturbing the other, in an owner-only file', async (t) => {
  const store = createStore(await tempDir(t));
  await store.update('x', () => ({ clientId: 'a' }));
  await store.update('linkedin', () => ({ clientId: 'b' }));
  await store.update('x', (current) => ({ ...current, tokens: { accessToken: 't' } }));
  assert.deepEqual(await store.read(), { x: { clientId: 'a', tokens: { accessToken: 't' } }, linkedin: { clientId: 'b' } });
  const mode = (await fs.stat(store.credentialsPath)).mode & 0o777;
  assert.equal(mode, 0o600);
  const leftovers = (await fs.readdir(path.dirname(store.credentialsPath))).filter((name) => name.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
});

test('store reports a corrupt credentials file instead of treating it as empty', async (t) => {
  const store = createStore(await tempDir(t));
  await fs.writeFile(store.credentialsPath, '{not json');
  await assert.rejects(store.read(), /not valid JSON/);
});

test('history keeps entries in order and ignores damaged lines', async (t) => {
  const store = createStore(await tempDir(t));
  await store.appendHistory({ platform: 'x', id: '1' });
  await fs.appendFile(store.historyPath, 'garbage\n');
  await store.appendHistory({ platform: 'linkedin', id: '2' });
  assert.deepEqual((await store.readHistory()).map((entry) => entry.id), ['1', '2']);
});

test('config normalises the public URL and rejects bad values', () => {
  const config = loadConfig({ PUBLIC_URL: 'https://poster.example.test/some/path/', PORT: '9000', SOCIAL_POSTER_DATA_DIR: '/tmp/x' });
  assert.equal(config.publicUrl, 'https://poster.example.test');
  assert.equal(callbackUrl(config, 'x'), 'https://poster.example.test/auth/x/callback');
  assert.equal(config.port, 9000);
  assert.throws(() => loadConfig({ PUBLIC_URL: 'not a url' }), /not a valid URL/);
  assert.throws(() => loadConfig({ PUBLIC_URL: 'ftp://example.test' }), /http/);
  assert.throws(() => loadConfig({ PORT: 'abc' }), /PORT/);
});

test('config prefers the explicit data directory over the process manager default', () => {
  assert.equal(loadConfig({ SOCIAL_POSTER_DATA_DIR: '/a', APP_DATA_DIR: '/b' }).dataDir, '/a');
  assert.equal(loadConfig({ APP_DATA_DIR: '/b' }).dataDir, '/b');
});
