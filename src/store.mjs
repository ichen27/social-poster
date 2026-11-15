import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

// Credentials and post history live in the data directory, outside the
// repository. Files are owner-only and replaced atomically.
const CREDENTIALS = 'credentials.json';
const HISTORY = 'history.jsonl';

export function createStore(dataDir) {
  const credentialsPath = path.join(dataDir, CREDENTIALS);
  const historyPath = path.join(dataDir, HISTORY);

  async function read() {
    let raw;
    try {
      raw = await fs.readFile(credentialsPath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return {};
      throw error;
    }
    try {
      return JSON.parse(raw);
    } catch {
      throw new Error(`${credentialsPath} is not valid JSON; fix or remove it and reconnect`);
    }
  }

  async function write(data) {
    await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
    const temporary = `${credentialsPath}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(data, null, 2), { mode: 0o600 });
    await fs.rename(temporary, credentialsPath);
  }

  // Read, change and write one platform's record.
  async function update(platform, change) {
    const data = await read();
    data[platform] = change(data[platform] || {});
    await write(data);
    return data[platform];
  }

  async function appendHistory(entry) {
    await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
    await fs.appendFile(historyPath, JSON.stringify(entry) + '\n', { mode: 0o600 });
  }

  async function readHistory() {
    let raw;
    try {
      raw = await fs.readFile(historyPath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    return raw
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }

  return { read, update, appendHistory, readHistory, credentialsPath, historyPath };
}
