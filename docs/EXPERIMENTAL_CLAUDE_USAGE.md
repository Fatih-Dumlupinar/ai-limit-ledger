# Experimental: CLI-free Claude Usage

This document explains the experimental "CLI-free Claude Usage" transport (commands `AI Limit Ledger: Enable/Disable CLI-free Claude Usage`, setting `aiLimitLedger.claude.experimentalOAuthUsage.enabled`). It is off by default and unrelated to the official Claude Code status-line integration, which remains the primary, documented source of 5-hour/7-day account limits.

## Why this exists

The official Claude Code status-line contract only reports account limits when the Claude CLI process itself runs a command and writes them out. If you only ever use the Claude Code VS Code sidebar and never invoke the CLI, the status-line never fires and AI Limit Ledger has no automatic source for your 5h/7d usage — that is the supported `manual-only` mode. This experimental transport is an alternative way to fill that gap without requiring the CLI process to be running.

## What it does

When you explicitly enable it, AI Limit Ledger:

1. Reads the OAuth access token Claude Code itself already stores locally (`~/.claude/.credentials.json`, read-only, never written to or refreshed).
2. Sends that token, only in memory, in a single HTTPS `GET` request to `api.anthropic.com/api/oauth/usage` — the same account-usage endpoint Claude Code's own `/usage` command uses.
3. Extracts only the 5-hour/7-day used-percentage and reset-time fields from the response.
4. Discards the token and the raw response the instant the request finishes.

## Data flow

```
Claude Code CLI/extension  →  ~/.claude/.credentials.json  (read-only)
                                        │
                          AI Limit Ledger reads access token (in memory only)
                                        │
                              HTTPS GET api.anthropic.com/api/oauth/usage
                                        │
                       allowlisted fields extracted → percentages + reset times
                                        │
                            token discarded, response discarded
                                        │
                        Dashboard shows: "Experimental — undocumented
                              Anthropic usage endpoint"
```

## What is never stored, logged, or transmitted elsewhere

- The access token is never written to disk, `globalState`, `workspaceState`, or VS Code Secret Storage, and is never included in logs, error messages, or the `Copy Claude Code Diagnostics` output.
- The refresh token is never read at all — AI Limit Ledger never attempts to refresh or rotate any Claude Code credential.
- The raw HTTP response body is never cached — only the allowlisted 5h/7d percentages and reset timestamps survive as a non-sensitive "last known good" snapshot, used solely to keep the dashboard populated during a rate-limit pause.
- No account id, email, session id, or subscription-plan field is ever read from either the credential file or the response, even if present.

## Threat model

| Risk                                                           | Mitigation                                                                                                                                                         |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Token leaked via logs/diagnostics                              | Token never enters any logger, error path, or diagnostics string; only allowlisted percentages do.                                                                 |
| Token persisted at rest                                        | Token lives only in a local variable for the duration of one request; never written to any store.                                                                  |
| Token exfiltrated to a third party                             | The transport is hard-coded to `https://api.anthropic.com/api/oauth/usage`; no other host is contacted, and redirects are never followed.                          |
| Malformed/oversized response crashes or misleads the extension | Response size is capped, content-type is checked, and only a small allowlist of numeric fields is parsed; anything else is treated as a failure, never guessed at. |
| Silent breakage if Anthropic changes the endpoint              | Any non-2xx/parse failure surfaces as a clearly labeled `authentication-required`/`unavailable`/`stale` state, never a fabricated percentage.                      |
| Hammering the endpoint / triggering account-wide rate limits   | A shared, cross-window minimum interval (120s+), single-flight, and an escalating 429 backoff (see below) apply regardless of how many VS Code windows are open.   |

## 429 (rate-limit) behavior

- `Retry-After` is honored exactly when the server sends one.
- Otherwise: 1st consecutive 429 → 2 minutes, 2nd → 4 minutes, 3rd → 8 minutes.
- After three consecutive 429s, AI Limit Ledger pauses for at least 15 minutes regardless of what a smaller `Retry-After` said.
- Backoff never exceeds 60 minutes.
- A successful request resets the counter.
- The last known good percentages are never discarded during a pause — the dashboard shows them, clearly marked `rate-limited — showing last known usage`.
- All VS Code windows share one backoff clock and one in-flight request; a manual refresh is subject to the exact same rules as an automatic one.

## Turning it off

Run `AI Limit Ledger: Disable CLI-free Claude Usage`, or set `aiLimitLedger.claude.experimentalOAuthUsage.enabled` to `false`. This immediately stops all credential reads and network requests from this transport and removes AI Limit Ledger's own Stop/StopFailure/SessionStart activity hook entries from `~/.claude/settings.json` (any of your own hooks on those events are left untouched). The official status-line integration is completely unaffected either way.

## Relationship to the Stop/StopFailure/SessionStart activity hooks

When you enable this transport, AI Limit Ledger also installs a small, additive hook into Claude Code's documented `Stop`, `StopFailure`, and `SessionStart` hook events. That hook writes exactly one allowlisted line — an event type, a timestamp, and a coarse category (`none`/`rate_limit`/`other`) — to a local activity file, and nothing else: never a prompt, a response, a transcript path, a working directory, tool input/output, a token, or any account identity. AI Limit Ledger reads that file only to decide _when_ it is worth attempting a refresh (subject to every gate above); the hook itself never supplies a percentage or a rate-limit decision.
