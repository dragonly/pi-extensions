# AGENTS.md

Rules for AI agents working in this repo.

## Privacy

- **Never commit personal secrets**: no API keys, tokens, passwords, auth credentials, or private URLs.
- **No personal identifiers**: no real names, emails, usernames, account IDs, or org-internal info.
- Extensions must be general-purpose and safe to publish publicly.

## Code

- Each extension goes in its own `.ts` file under the repo root.
- Keep extensions self-contained; no dependencies outside `@mariozechner/pi-coding-agent` and `@mariozechner/pi-tui`.
- Update `README.md` when adding or removing an extension.
