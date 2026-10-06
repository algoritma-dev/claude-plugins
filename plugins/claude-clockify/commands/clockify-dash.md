---
description: Start the local Claude Clockify dashboard and show its URL
---

Start the Claude Clockify dashboard.

1. Run this command in the background (the `run_in_background` parameter of the Bash tool): `node "${CLAUDE_PLUGIN_ROOT}/server/main.js"`
2. Read the process's initial output and look for the line starting with `Dashboard:` or `Dashboard already running:`.
3. Tell the user the printed URL (usually `http://127.0.0.1:4747`). The browser is opened automatically when possible.
4. If the line is `Dashboard already running: <url>`, the process exits immediately with code 0: this is not an error, the dashboard was already running (reopened in the browser). Report the URL and do not start another one.
5. If the process exits immediately with an error (port in use by another program, Node.js too old), report the message to the user without retrying in a loop: the port can be changed from Settings in the dashboard or in `~/.claude-clockify/config.json`.

Do not send anything to Clockify and do not change the configuration: the dashboard is only for reviewing entries and sending them with a click from the user.
