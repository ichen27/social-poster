# Social Poster

Repository: https://github.com/ichen27/social-poster (private). Canonical checkout: `/Volumes/SamsungSSD1/code/social-poster` on the Mac mini. Read `README.md` and `docs/design.md` first.

## What it is

A dependency-free Node tool that previews and publishes a post to X and LinkedIn from a JSON draft, plus a small connect page for signing in to each platform.

## Layout

- `src/cli.mjs` — commands. `src/post.mjs` — draft validation, confirmation code, publishing.
- `src/x.mjs`, `src/linkedin.mjs` — one function per platform call. `src/http.mjs` — shared request and error handling.
- `src/connections.mjs` — connection status and token renewal. `src/store.mjs` — credential and history files.
- `src/server.mjs`, `src/main.mjs` — the connect page.

## Conventions

- No npm dependencies. Platform calls take `fetchImpl` as a parameter so tests can simulate them.
- Never print, log, return or render a token or client secret. Errors from `callApi` carry only the status and the platform's message.
- Only the CLI renews tokens; the server must not.
- Publishing must stay behind the confirmation code. Do not add a flag that bypasses it.
- The connect page must not gain a route that posts.

## Validate

`bash ci/run.sh` runs `npm test` and `npm run check`. Tests need no credentials and post nothing. CI (`.github/workflows/checks.yml`) runs the same script on GitHub-hosted `ubuntu-24.04` for pull requests and pushes to `main`; the check is named `test`. Keep `.node-version` on the major version of `/opt/homebrew/bin/node`.

## Running on the mini

- Deployed to Limelight Labs OS as `social-poster` (https://app-social-poster.chenagent.com, port 8945) from `launcher.json`.
- Settings: `/Volumes/SamsungSSD1/tools/social-poster/app.env` (`PUBLIC_URL`, `SOCIAL_POSTER_DATA_DIR`). Credentials and history: `/Volumes/SamsungSSD1/tools/app-launcher/apps/social-poster`. Neither is in the repository.
- CLI: `/opt/homebrew/bin/node --env-file=/Volumes/SamsungSSD1/tools/social-poster/app.env /Volumes/SamsungSSD1/code/social-poster/src/cli.mjs <command>`.
- After merging a change to `src/server.mjs`, update the canonical checkout and restart with the launcher CLI (`node src/cli.mjs restart social-poster` in the app-launcher checkout).

## Publishing a post

Publishing reaches real accounts and cannot be cleanly undone. Run `preview`, show the owner the full output, and run `publish --confirm <code>` only after they approve that output in the current conversation.

## Workflow

Work on a feature branch, open a pull request into `main`, and merge only after `test` passes on the current revision. Branch protection is not available for private repositories on the current plan, so check the result yourself. Commit as `ichen27 <ivan27chen@gmail.com>`.
