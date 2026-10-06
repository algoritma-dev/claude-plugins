import http from 'node:http';

const PROJECTS = [
  { id: 'p1', name: 'Alpha' },
  { id: 'p2', name: 'Beta' },
  { id: 'big', name: 'Big project' },
];
const BIG_TASKS = Array.from({ length: 450 }, (_, i) => ({ id: `bt${i + 1}`, name: `Task ${i + 1}` }));
const TASKS = [
  { id: 't1', name: 'Development' },
  { id: 't2', name: 'Analysis' },
];
const TAGS = [
  { id: 'g1', name: 'bug' },
  { id: 'g2', name: 'feature' },
];

export async function startFakeClockify() {
  const requests = [];
  let failStatus = null;
  let hang = false;
  let hold = null; // { released: Promise, arrived() } for the next request to hold
  let raw_next = null;
  let counter = 0;

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body = null;
      if (raw) {
        try {
          body = JSON.parse(raw);
        } catch {
          body = raw;
        }
      }
      const url = new URL(req.url, 'http://127.0.0.1');
      requests.push({ method: req.method, path: url.pathname, query: url.search, headers: req.headers, body });

      if (hang) {
        hang = false;
        return; // never respond
      }
      if (hold) {
        const { released, arrived } = hold;
        hold = null;
        arrived();
        released.then(() => route());
        return undefined;
      }
      return route();
    });

    function route() {
      const url = new URL(req.url, 'http://127.0.0.1');
      const send = (status, payload) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      if (raw_next !== null) {
        const { status, text } = raw_next;
        raw_next = null;
        res.writeHead(status, { 'Content-Type': 'application/json' });
        return res.end(text);
      }

      if (failStatus !== null) {
        const status = failStatus;
        failStatus = null;
        return send(status, { message: 'forced failure', code: status });
      }

      const p = url.pathname;
      const m = req.method;
      if (m === 'GET' && p === '/api/v1/user') {
        return send(200, { id: 'u1', defaultWorkspace: 'ws1' });
      }
      if (m === 'GET' && /^\/api\/v1\/workspaces\/[^/]+\/projects$/.test(p)) {
        return send(200, PROJECTS);
      }
      if (m === 'GET' && /^\/api\/v1\/workspaces\/[^/]+\/projects\/[^/]+\/tasks$/.test(p)) {
        if (p.includes('/projects/big/')) {
          const size = Number(url.searchParams.get('page-size') ?? 50);
          const page = Number(url.searchParams.get('page') ?? 1);
          return send(200, BIG_TASKS.slice((page - 1) * size, page * size));
        }
        return send(200, TASKS);
      }
      if (m === 'GET' && /^\/api\/v1\/workspaces\/[^/]+\/tags$/.test(p)) {
        return send(200, TAGS);
      }
      if (m === 'POST' && /^\/api\/v1\/workspaces\/[^/]+\/time-entries$/.test(p)) {
        counter += 1;
        return send(201, { id: `e${counter}` });
      }
      const put = /^\/api\/v1\/workspaces\/[^/]+\/time-entries\/([^/]+)$/.exec(p);
      if (m === 'PUT' && put) {
        return send(200, { id: put[1] });
      }
      return send(404, { message: 'not found' });
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}/api/v1`,
    requests,
    failNext(status) {
      failStatus = status;
    },
    hangNext() {
      hang = true;
    },
    /** Holds the next request until release() is called; `arrived` resolves when it reaches the fake. */
    holdNext() {
      let release;
      let arrived;
      const released = new Promise((r) => { release = r; });
      const arrivedP = new Promise((r) => { arrived = r; });
      hold = { released, arrived };
      return { release, arrived: arrivedP };
    },
    respondNext(status, text) {
      raw_next = { status, text };
    },
    close() {
      return new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}
