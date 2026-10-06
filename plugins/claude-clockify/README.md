# Claude Clockify

Claude Code plugin that automatically records when you work with Claude and turns that activity into time entries you review and send to [Clockify](https://clockify.me) from a local dashboard. Nothing is sent to Clockify without a click from you.

## Requirements

- Node.js >= 22.13 (uses the `node:sqlite` module, available without flags from this version; verified on Node 24). On older versions the dashboard refuses to start and prints a message. No npm dependencies.
- A Clockify account with an API key (Clockify > Profile > Settings > API).

## Installation

1. Add the Algoritma marketplace (if you have not already) and install the plugin from the **Marketplace** tab of `/plugin`: see the [marketplace README](../../README.md#installation).
   Alternatively, to try it from a local copy: `claude --plugin-dir /path/to/plugins/claude-clockify`.
2. Restart the session: the `SessionStart`, `UserPromptSubmit`, `Stop` and `SessionEnd` hooks (in `hooks/hooks.json`) start recording events in `~/.claude-clockify/data.sqlite`.

## Clockify token

Open the dashboard (`/clockify-dash`), go to **Settings** and paste the API key. It is saved in `~/.claude-clockify/config.json` with permissions `600` (your user only). In Settings you can also change the threshold, margin, port and workspace.

## Usage

1. **Automatic recording.** The hooks write events without you doing anything.
2. **Dashboard.** Type `/clockify-dash` in Claude Code: it starts the local server, prints the URL (`Dashboard: http://127.0.0.1:4747`) and opens the browser. If the dashboard is already running it prints `Dashboard already running: <url>` and reopens it. To skip opening the browser use `--no-open` or the `NO_OPEN=1` variable.
3. **Import transcripts.** The import button reads past Claude Code transcripts (`~/.claude/projects`) and adds them as events, so you also recover work done before installing the plugin.
4. **Folder -> project mapping.** Map each working folder to a Clockify project (with optional task and tags): new entries of that folder are created already filled in.
5. **Review and send.** Edit minutes, task, project and description; **Close now** closes an entry that is still in progress; **Send** creates the entry on Clockify; **Resend** updates an entry that was already sent (no duplicates).

## How time is computed

- A session's events are grouped into blocks: if at least **10 minutes** (the threshold) pass between two events, the block ends and a new one starts. `SessionEnd` and "Close now" always close the block.
- While Claude works on a prompt (from the prompt to the next `Stop`) the block is never split and the entry stays `in_progress`, for at most 4 hours after the prompt.
- A session opened and closed without prompts or replies produces no entries.
- Duration = last event - first event of the block + a **2 minute** margin.
- Entry statuses: `in_progress` (block still open, cannot be edited or sent), `proposed` (block closed), `edited` (changed by you), `sent` (present on Clockify). A sent entry is never altered by new activity: new activity creates a new `in_progress` entry.
- Threshold and margin are configurable (defaults 10 and 2).

## Privacy and security

- The server listens only on `127.0.0.1` and checks `Host`/`Origin` (DNS rebinding defense); mutating requests require a random session token (anti-CSRF).
- The Clockify token is never sent to the browser: the dashboard only knows whether it is set.
- The hooks store only timestamps, session id, folder and the first 200 characters of the prompts; the data stays local in `~/.claude-clockify/` (folder with permissions `700`, database and logs with permissions `600`).
- Only what you confirm with a click on Send/Resend is sent to Clockify.
- On a computer shared with other users, anyone with local access to the machine can open the dashboard page on `127.0.0.1` while it is running: multi-user use is not supported (out of scope).

## Development

```
npm test                          # automated tests (node --test "test/*.test.js")
node test/helpers/dev-server.js   # dashboard with fake data and a fake Clockify (PORT=5000 to change the port)
```
