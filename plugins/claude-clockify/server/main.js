// Entry point of the dashboard: starts the local server, prints the URL and opens the browser (best effort).
//   node server/main.js [--no-open]        (NO_OPEN=1 behaves like --no-open)
// If the port is already taken by a running dashboard, prints its URL, opens it and exits 0.
import { spawn } from 'node:child_process';

const MIN_NODE = [22, 13]; // node:sqlite without --experimental-sqlite

function nodeTooOld() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  return major < MIN_NODE[0] || (major === MIN_NODE[0] && minor < MIN_NODE[1]);
}

function openBrowser(url) {
  const cmds = {
    linux: ['xdg-open', [url]],
    darwin: ['open', [url]],
    win32: ['cmd', ['/c', 'start', '""', url]],
  };
  const entry = cmds[process.platform];
  if (!entry) return;
  try {
    const child = spawn(entry[0], entry[1], { detached: true, stdio: 'ignore' });
    child.on('error', () => {}); // opener missing: ignore
    child.unref();
  } catch {
    // ignore
  }
}

/** True if the server on the port looks like this dashboard (page with the session-token meta tag). */
async function isDashboard(url) {
  try {
    const res = await fetch(`${url}/`, { signal: AbortSignal.timeout(1500) });
    return res.ok && (await res.text()).includes('name="session-token"');
  } catch {
    return false;
  }
}

async function main() {
  if (nodeTooOld()) {
    console.error(
      `Error: Node.js ${MIN_NODE.join('.')} or later is required (node:sqlite module); `
      + `running version: ${process.versions.node}.`,
    );
    process.exit(1);
  }
  // Imported only after the version check: node:sqlite is missing or flagged on older versions.
  const { startServer } = await import('./server.js');
  const { loadConfig } = await import('../core/config.js');

  const skipOpen = process.argv.includes('--no-open') || process.env.NO_OPEN === '1';
  let srv;
  try {
    srv = await startServer();
  } catch (err) {
    if (err?.code === 'EADDRINUSE') {
      const { port } = loadConfig();
      const url = `http://127.0.0.1:${port}`;
      if (await isDashboard(url)) {
        console.log(`Dashboard already running: ${url}`);
        if (!skipOpen) openBrowser(url);
        process.exit(0);
      }
      console.error(
        `Error: port ${port} is already in use by another program. `
        + 'Change the port in ~/.claude-clockify/config.json (field "port") or in the dashboard Settings.',
      );
    } else {
      console.error(`Error starting the dashboard: ${err?.message ?? err}`);
    }
    process.exit(1);
  }

  console.log(`Dashboard: ${srv.url}`);
  if (!skipOpen) openBrowser(srv.url);

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    try {
      await srv.close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

await main();
