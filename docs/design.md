# Design notes

Written 15 November 2026.

## Goal

When an app is finished, announce it on X and LinkedIn from the same place the app was built, without a wrong post ever going out unreviewed.

## Decisions

**Approval is enforced by the tool, not by convention.** `preview` prints a confirmation code derived from the final text of every target and the image bytes. `publish` refuses unless it is given the code for the draft as it currently is. Whoever runs `publish` must therefore have run `preview` on identical content, which is what the person approving saw.

**Sign-in happens in a browser, on a page served by this tool.** Both platforms use OAuth, which ends by redirecting the browser to a registered callback URL. Hosting that callback here means connecting an account is one click, and reconnecting when a sign-in expires is the same click.

**The connect page cannot post.** It only saves app credentials and sign-ins. Keeping publishing out of the web surface means a cross-site request can at worst start a sign-in the user must still approve.

**X uses OAuth 2.0 with PKCE and a refresh token.** X's documentation describes every posting and media call with an OAuth 2.0 user token. Access tokens last two hours, so the tool renews them before posting. X replaces the refresh token on each renewal, so the new one is saved before it is used.

**Only the command-line tool renews tokens.** The connect page reads the stored expiry but never refreshes. With a single writer there is no race in which two processes exchange the same single-use refresh token.

**LinkedIn uses the self-serve "Share on LinkedIn" product** and its `ugcPosts` endpoint, which is what that product documents. Whether a self-serve app receives a refresh token is not something this project has confirmed, so both cases are handled.

**No dependencies.** Node's built-in `fetch`, `http`, `crypto` and test runner cover everything, which keeps installation to a clone.

## Deliberately left out

Scheduling, threads, video, analytics, company pages, and a review screen in the browser. Each would be a separate decision.

## Known gaps

- Not yet exercised against the live APIs.
- A post accepted by a platform whose response is lost is not recorded.
- Credentials are in an owner-only file, not an encrypted store.
