#!/usr/bin/env node
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.mjs';
import { createStore } from './store.mjs';
import { LABELS, PLATFORMS, describeConnections } from './connections.mjs';
import { readDraft, buildPlan, formatPlan, publish } from './post.mjs';

const USAGE = `Usage:
  social-poster status [--json]
  social-poster preview <draft.json> [--allow-duplicate] [--allow-long]
  social-poster publish <draft.json> --confirm <code> [--allow-duplicate] [--allow-long]

preview prints exactly what would be posted and a confirmation code.
publish posts only when given the code from a preview of the same content.`;

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--confirm') {
      flags.confirm = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--')) {
      flags[arg.slice(2)] = true;
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

// Returns the process exit code. Dependencies are injectable for tests.
export async function run(argv, { env = process.env, fetchImpl = fetch, out = console.log, err = console.error, now = Date.now() } = {}) {
  const { flags, positional } = parseArgs(argv);
  const [command, draftPath] = positional;
  const known = ['json', 'confirm', 'allow-duplicate', 'allow-long', 'help'];
  const unknown = Object.keys(flags).filter((flag) => !known.includes(flag));
  if (unknown.length) {
    err(`Unknown option --${unknown[0]}\n\n${USAGE}`);
    return 2;
  }
  if (!command || flags.help) {
    out(USAGE);
    return command ? 0 : 2;
  }

  const config = loadConfig(env);
  const store = createStore(config.dataDir);

  if (command === 'status') {
    const status = describeConnections(await store.read(), now);
    if (flags.json) {
      out(JSON.stringify({ connectPage: config.publicUrl, ...status }, null, 2));
    } else {
      for (const platform of PLATFORMS) {
        const entry = status[platform];
        const state = entry.connected ? `connected${entry.account ? ` as ${entry.account}` : ''}` : entry.appSaved ? 'not connected' : 'app details not saved';
        out(`${LABELS[platform]}: ${state}${entry.note ? ` — ${entry.note}` : ''}`);
      }
      out(`Connect page: ${config.publicUrl}`);
    }
    return 0;
  }

  if (command !== 'preview' && command !== 'publish') {
    err(`Unknown command "${command}"\n\n${USAGE}`);
    return 2;
  }
  if (!draftPath) {
    err(`${command} needs a draft file\n\n${USAGE}`);
    return 2;
  }

  const { draft, baseDir } = await readDraft(draftPath);
  const plan = await buildPlan({
    draft,
    baseDir,
    store,
    allowDuplicate: Boolean(flags['allow-duplicate']),
    allowLong: Boolean(flags['allow-long']),
    now,
  });
  out(formatPlan(plan));

  if (command === 'preview') return plan.problems.length ? 1 : 0;

  if (plan.problems.length) return 1;
  if (flags.confirm !== plan.confirmCode) {
    err(
      flags.confirm
        ? `\nConfirmation code does not match this draft (expected ${plan.confirmCode}). The content changed since it was previewed; review it again.`
        : '\nNothing was posted: publish needs --confirm with the code shown above.',
    );
    return 1;
  }

  const results = await publish(plan, { store, fetchImpl, config, now });
  out('');
  for (const result of results) {
    const label = LABELS[result.platform];
    if (result.status === 'posted') out(`${label}: posted ${result.url}`);
    else if (result.status === 'skipped') out(`${label}: skipped, already posted ${result.url}`);
    else err(`${label}: FAILED — ${result.error}`);
  }
  return results.some((result) => result.status === 'failed') ? 1 : 0;
}

// Compare real paths so the command also runs when started through a symlink.
function startedDirectly() {
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (startedDirectly()) {
  run(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(error.message);
      process.exitCode = 1;
    },
  );
}
