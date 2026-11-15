# Contributing

1. Create a branch from `main`.
2. Make the change with a test that fails without it.
3. Run `bash ci/run.sh` and confirm it passes.
4. Open a pull request that says what changed, why, and how you checked it.

Tests must not contact X or LinkedIn or need credentials; use the simulated `fetch` in `tests/helpers.mjs`.

## Reporting issues

Open a GitHub issue with the command you ran, what you expected and what happened. Never paste a token, a client secret, or the contents of `credentials.json`. Error messages from this tool are written to be safe to share.
