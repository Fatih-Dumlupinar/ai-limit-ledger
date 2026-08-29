# Settings and language behavior

## Dashboard insights mode

`aiLimitLedger.dashboard.insightsMode` is a window-scoped, render-only setting shared by the Rich and Safe Native Dashboards:

- `summary` (default) shows the most important 3–5 provider insights and keeps the rest collapsed.
- `detailed` shows the full allowlisted set in an expandable details section.
- `hidden` hides insights while preserving the main quota cards and reset information.

Changing this setting re-renders the current cached snapshots only. It never refreshes a provider, calls a network endpoint, reads credentials, starts a CLI/App Server, or resets an action.

The typed settings service reads and normalizes all `aiLimitLedger` settings. `display.language` accepts `auto`, `en`, and `tr`:

- `auto` follows `vscode.env.language`; Turkish variants beginning with `tr`, including `tr`, `tr-TR`, and `tr_TR`, select Turkish.
- `en` and `tr` explicitly override the VS Code display language.
- Unsupported locales use English fallback text.

Changing this setting updates the Rich Dashboard, Safe Native Dashboard, status bar, tooltip, notifications, pickers, and action feedback without reloading the window. The event is render-only: it reuses the current cached snapshots and does not refresh providers, read credentials, start processes, replay actions, or make network calls. A running action keeps its request ID, correlation ID, mutex, and state.

`display.timeFormat` supports `locale`, `relative`, `absolute`, and `both`. Turkish uses `tr-TR`; English uses `en-US` for the central localization formatter. Invalid timestamps render as the localized “Not provided” value and are never converted to a 1970 date.

The extension manifest uses `package.nls.json` and `package.nls.tr.json` for Command Palette and Settings contribution strings. These strings are controlled by VS Code's display language when contributions are loaded. They are not controlled by `display.language` and may require Reload Window to change.
