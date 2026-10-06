export class ClockifyError extends Error {
  constructor(message, { status = null, kind = 'other' } = {}) {
    super(message);
    this.name = 'ClockifyError';
    this.status = status;
    this.kind = kind;
  }
}

function kindForStatus(status) {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate';
  return 'other';
}

function pickIdName(list) {
  return (Array.isArray(list) ? list : []).map((x) => ({ id: x.id, name: x.name }));
}

function entryBody(e) {
  const body = {
    start: e.start,
    end: e.end,
    description: e.description,
    projectId: e.projectId,
  };
  if (e.taskId) body.taskId = e.taskId;
  if (Array.isArray(e.tagIds) && e.tagIds.length > 0) body.tagIds = e.tagIds;
  return body;
}

export function toClockifyEntry(entry) {
  const endMs = entry.startAt + Math.round(entry.minutes * 60) * 1000;
  const out = {
    start: new Date(entry.startAt).toISOString(),
    end: new Date(endMs).toISOString(),
    description: entry.description,
    projectId: entry.projectId,
  };
  if (entry.taskId) out.taskId = entry.taskId;
  if (Array.isArray(entry.tagIds) && entry.tagIds.length > 0) out.tagIds = entry.tagIds;
  return out;
}

const unexpected = (status) =>
  new ClockifyError(`Clockify HTTP ${status}: unexpected response`, { status, kind: 'other' });

export function createClient({ token, baseUrl, timeoutMs = 15000 }) {
  const base = String(baseUrl ?? '').replace(/\/+$/, '');
  const mask = (t) => (token ? String(t).split(token).join('***') : String(t));

  function mapFetchError(err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      return new ClockifyError(`Clockify request timeout after ${timeoutMs}ms`, {
        status: null,
        kind: 'network',
      });
    }
    const reason = err?.cause?.code ?? err?.cause?.message ?? err?.message ?? 'fetch failed';
    return new ClockifyError(`Clockify network error: ${mask(reason)}`, { status: null, kind: 'network' });
  }

  async function request(method, path, body) {
    if (!token) {
      throw new ClockifyError('Clockify API key missing', { status: null, kind: 'auth' });
    }
    let res;
    let text;
    try {
      res = await fetch(base + path, {
        method,
        headers: { 'X-Api-Key': token, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      text = await res.text();
    } catch (err) {
      throw mapFetchError(err);
    }
    if (!res.ok) {
      const snippet = mask(text.slice(0, 200));
      throw new ClockifyError(`Clockify HTTP ${res.status}${snippet ? `: ${snippet}` : ''}`, {
        status: res.status,
        kind: kindForStatus(res.status),
      });
    }
    if (text.trim() === '') return undefined;
    try {
      return JSON.parse(text);
    } catch {
      throw unexpected(res.status);
    }
  }

  const ws = (id) => `/workspaces/${encodeURIComponent(id)}`;
  const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

  const PAGE_SIZE = 200;
  const MAX_PAGES = 50;

  /** Fetches every page so large projects get their full list in a single dashboard request. */
  async function list(path, filter = '') {
    const out = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const r = await request('GET', `${path}?page-size=${PAGE_SIZE}${filter}${page > 1 ? `&page=${page}` : ''}`);
      if (!Array.isArray(r)) throw unexpected(200);
      out.push(...r);
      if (r.length < PAGE_SIZE) break;
    }
    return pickIdName(out);
  }
  async function idOf(r) {
    if (!isObj(r) || typeof r.id !== 'string') throw unexpected(200);
    return { id: r.id };
  }

  return {
    getUser: async () => {
      const u = await request('GET', '/user');
      if (!isObj(u) || typeof u.id !== 'string') throw unexpected(200);
      return { id: u.id, defaultWorkspace: u.defaultWorkspace };
    },
    listProjects: (w) => list(`${ws(w)}/projects`, '&archived=false'),
    listTasks: (w, projectId) => list(`${ws(w)}/projects/${encodeURIComponent(projectId)}/tasks`, '&is-active=true'),
    listTags: (w) => list(`${ws(w)}/tags`),
    /** Finished time entries of a user in [startIso, endIso), with project, task and tag names resolved. */
    listTimeEntries: async (w, userId, startIso, endIso) => {
      const out = [];
      const path = `${ws(w)}/user/${encodeURIComponent(userId)}/time-entries`;
      const range = `&start=${encodeURIComponent(startIso)}&end=${encodeURIComponent(endIso)}`;
      for (let page = 1; page <= MAX_PAGES; page++) {
        const r = await request('GET', `${path}?hydrated=true&page-size=${PAGE_SIZE}${range}${page > 1 ? `&page=${page}` : ''}`);
        if (!Array.isArray(r)) throw unexpected(200);
        out.push(...r);
        if (r.length < PAGE_SIZE) break;
      }
      return out
        .filter((e) => isObj(e) && isObj(e.timeInterval) && e.timeInterval.start && e.timeInterval.end)
        .map((e) => ({
          id: e.id,
          start: e.timeInterval.start,
          end: e.timeInterval.end,
          description: e.description ?? '',
          project: e.project?.name ?? '',
          task: e.task?.name ?? '',
          tags: Array.isArray(e.tags) ? e.tags.map((t) => t.name) : [],
        }));
    },
    createEntry: async (w, e) => idOf(await request('POST', `${ws(w)}/time-entries`, entryBody(e))),
    updateEntry: async (w, id, e) =>
      idOf(await request('PUT', `${ws(w)}/time-entries/${encodeURIComponent(id)}`, entryBody(e))),
  };
}
