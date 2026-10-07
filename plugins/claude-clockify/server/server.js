import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadConfig, saveConfig } from '../core/config.js';
import { openDb } from '../core/db.js';
import {
  reconcile, listEntries, updateEntry, dismissEntry, closeNow, recordSent, setMapping, deleteMapping, listMappings,
} from '../core/entries.js';
import { quarterHour } from '../core/blocks.js';
import { importTranscripts } from '../core/transcripts.js';
import { createClient, ClockifyError, toClockifyEntry } from '../clockify/client.js';
import { checkRequest } from './security.js';
import { fillTemplate, previewTable, currentMonth, profileColumns, rowCount } from '../core/export.js';
import { loadProfileState, collectMonth } from '../core/export-service.js';

const PKG_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BODY_LIMIT = 1024 * 1024;
const STATUSES = new Set(['in_progress', 'proposed', 'edited', 'sent', 'dismissed']);
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const PREVIEW_ROWS = 50;
const DESC_MAX = 500;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'",
};

class HttpError extends Error {
  constructor(status, kind, message) {
    super(message);
    this.status = status;
    this.kind = kind;
  }
}
const bad = (message) => new HttpError(400, 'validation', message);

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const isNonEmptyStr = (x) => typeof x === 'string' && x.length > 0;
const isOptStr = (x) => x === null || isNonEmptyStr(x);
const isStrArray = (x) => Array.isArray(x) && x.every(isNonEmptyStr);

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendError(res, status, kind, message) {
  if (res.headersSent) return res.destroy();
  sendJson(res, status, { error: { kind, message } });
}

/** Reads a JSON body (limit 1 MB). Oversized bodies are drained and rejected with 413. */
function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > BODY_LIMIT) tooLarge = true;
      else chunks.push(c);
    });
    req.on('error', reject);
    req.on('end', () => {
      if (tooLarge) return reject(new HttpError(413, 'too_large', 'Request body exceeds 1 MB'));
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw.trim() === '') return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(bad('Invalid JSON body'));
      }
    });
  });
}

function decodeSegment(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    throw bad('Malformed URL');
  }
}

function parseKey(sessionId, startTs) {
  if (!isNonEmptyStr(sessionId) || !/^\d+$/.test(startTs)) throw bad('Invalid entry key');
  return { sessionId, startTs: Number(startTs) };
}

function isValidKey(k) {
  return isObj(k) && isNonEmptyStr(k.sessionId) && Number.isSafeInteger(k.startTs) && k.startTs >= 0;
}

function rowStatus(db, key) {
  const row = db.prepare('SELECT status FROM entries WHERE sessionId = ? AND startTs = ?').get(key.sessionId, key.startTs);
  return row?.status ?? null;
}

function findEntry(db, key) {
  return listEntries(db).find((e) => e.sessionId === key.sessionId && e.startTs === key.startTs) ?? null;
}

function validatePatch(patch) {
  if (!isObj(patch) || Object.keys(patch).length === 0) throw bad('Patch must be a non-empty object');
  for (const [k, v] of Object.entries(patch)) {
    switch (k) {
      case 'minutes':
        if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > 24 * 60) throw bad('minutes must be a positive number');
        patch.minutes = quarterHour(v);
        break;
      case 'startAt':
        if (!Number.isSafeInteger(v) || v < 0) throw bad('startAt must be a timestamp in ms');
        break;
      case 'projectId':
      case 'taskId':
        if (!isOptStr(v)) throw bad(`${k} must be a string or null`);
        break;
      case 'tagIds':
        if (!isStrArray(v)) throw bad('tagIds must be an array of strings');
        break;
      case 'description':
        if (v !== null && (typeof v !== 'string' || v.length > DESC_MAX)) {
          throw bad(`description must be a string of at most ${DESC_MAX} characters or null`);
        }
        break;
      default:
        throw bad(`Field not editable: ${k}`);
    }
  }
}

/** Validates a settings patch; returns the normalized patch. Never echoes the token. */
function validateSettings(body) {
  if (!isObj(body)) throw bad('Settings must be an object');
  const out = {};
  for (const [k, v] of Object.entries(body)) {
    switch (k) {
      case 'thresholdMin':
        if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) throw bad('thresholdMin must be a positive number');
        out[k] = v;
        break;
      case 'marginMin':
        if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw bad('marginMin must be a non-negative number');
        out[k] = v;
        break;
      case 'port':
        if (!Number.isInteger(v) || v < 1 || v > 65535) throw bad('port must be an integer between 1 and 65535');
        out[k] = v;
        break;
      case 'clockifyToken':
        if (typeof v !== 'string' || v.length > 512) throw bad('clockifyToken must be a string');
        out[k] = v.trim() === '' ? null : v.trim();
        break;
      case 'workspaceId':
        if (v !== null && typeof v !== 'string') throw bad('workspaceId must be a string or null');
        out[k] = v === null || v.trim() === '' ? null : v.trim();
        break;
      default:
        throw bad(`Unknown setting: ${String(k).slice(0, 50)}`);
    }
  }
  return out;
}

function publicSettings(cfg) {
  const { clockifyToken, ...rest } = cfg;
  return { ...rest, tokenSet: Boolean(clockifyToken) };
}

function clockifyErrorBody(e) {
  return { kind: e.kind, message: e.message };
}

/**
 * @param {{port?: number, db?: import('node:sqlite').DatabaseSync, now?: () => number, uiDir?: string,
 *   reconcileIntervalMs?: number, projectsDir?: string, clockifyTimeoutMs?: number,
 *   log?: (...args: string[]) => void}} [opts] log: periodic reconcile errors (default console.error)
 * @returns {Promise<{url: string, port: number, sessionToken: string, close(): Promise<void>}>}
 */
export async function startServer(opts = {}) {
  const ownDb = !opts.db;
  const db = opts.db ?? openDb();
  const now = opts.now ?? Date.now;
  const uiDir = path.resolve(opts.uiDir ?? path.join(PKG_DIR, 'ui'));
  const intervalMs = opts.reconcileIntervalMs ?? 5000;
  const sessionToken = crypto.randomBytes(16).toString('hex');
  const sseClients = new Set();
  const inFlight = new Set();
  let lastJson = null;
  let port;

  // Clockify state: cached per config fingerprint so settings changes invalidate it.
  let cacheKey = null;
  let workspaceCache = null;
  const listCache = new Map();

  function clockifyContext() {
    const cfg = loadConfig();
    const key = JSON.stringify([cfg.clockifyToken, cfg.baseUrl, cfg.workspaceId]);
    if (key !== cacheKey) {
      cacheKey = key;
      workspaceCache = null;
      listCache.clear();
    }
    const client = createClient({ token: cfg.clockifyToken, baseUrl: cfg.baseUrl, timeoutMs: opts.clockifyTimeoutMs });
    const workspace = async () => {
      if (cfg.workspaceId) return cfg.workspaceId;
      if (!workspaceCache) {
        const p = client.getUser().then((u) => {
          if (!isNonEmptyStr(u.defaultWorkspace)) {
            throw new ClockifyError('Clockify user has no default workspace', { kind: 'other' });
          }
          return u.defaultWorkspace;
        });
        workspaceCache = p;
        p.catch(() => { if (workspaceCache === p) workspaceCache = null; });
      }
      return workspaceCache;
    };
    return { client, workspace };
  }

  // ---------- SSE ----------
  function entriesJson() {
    return JSON.stringify(listEntries(db));
  }
  function broadcast(json = entriesJson()) {
    lastJson = json;
    for (const res of sseClients) {
      if (!res.destroyed && !res.writableEnded) res.write(`event: entries\ndata: ${json}\n\n`);
    }
  }
  // Signature of the events table: when it is unchanged and nothing is in progress, a tick has nothing to do.
  const eventsSigStmt = db.prepare('SELECT count(*) AS n, max(ts) AS m FROM events');
  const liveStmt = db.prepare("SELECT 1 AS x FROM entries WHERE status = 'in_progress' LIMIT 1");
  let lastSig = null;
  const eventsSig = () => {
    const r = eventsSigStmt.get();
    return `${r.n}:${r.m}`;
  };
  /** Full reconcile: after an import, a settings change and at start (catches back-dated events). */
  function reconcileFull() {
    lastSig = eventsSig(); // taken before reading events: an event inserted meanwhile changes the next signature
    reconcile(db, now(), { full: true });
  }
  function reconcileAndPush() {
    reconcileFull();
    broadcast();
  }

  reconcileFull();
  lastJson = entriesJson();

  const log = opts.log ?? console.error;
  let lastErrorLog = -Infinity;
  const timer = setInterval(() => {
    try {
      const sig = eventsSig();
      if (sig === lastSig && !liveStmt.get()) return;
      reconcile(db, now());
      lastSig = sig;
      const json = entriesJson();
      if (json !== lastJson) broadcast(json);
    } catch (err) {
      // keep serving; next tick retries. Logged at most once per minute (never the token: DB/SQL errors only).
      if (Date.now() - lastErrorLog >= 60000) {
        lastErrorLog = Date.now();
        log('[clockify] reconcile failed:', err?.message ?? String(err));
      }
    }
  }, intervalMs);
  timer.unref();

  // ---------- send ----------
  const flightId = (k) => `${k.sessionId}\u0000${k.startTs}`;
  function assertNotSending(key) {
    if (inFlight.has(flightId(key))) throw new HttpError(409, 'busy', 'Entry is being sent to Clockify');
  }

  async function sendOne(key, resend, ctx) {
    if (!isValidKey(key)) {
      return { key, ok: false, error: { kind: 'validation', message: 'Invalid entry key' } };
    }
    const k = { sessionId: key.sessionId, startTs: key.startTs };
    const id = flightId(k);
    const fail = (kind, message) => ({ key: k, ok: false, error: { kind, message } });
    if (inFlight.has(id)) return fail('busy', 'Entry is already being sent');
    inFlight.add(id);
    try {
      const e = findEntry(db, k);
      if (!e) return fail('notfound', 'Entry not found');
      if (e.status === 'in_progress') return fail('state', 'Entry is still in progress');
      if (e.status === 'sent' && !resend) return fail('state', 'Entry already sent; use resend to update it');
      if (e.status === 'sent' && !e.clockifyId) return fail('state', 'Sent entry has no Clockify id');
      if (!e.projectId) return fail('validation', 'Entry has no Clockify project');
      const ws = await ctx.workspace();
      const body = toClockifyEntry(e);
      if (e.status === 'sent') {
        await ctx.client.updateEntry(ws, e.clockifyId, body);
        return { key: k, ok: true, clockifyId: e.clockifyId };
      }
      const created = await ctx.client.createEntry(ws, body);
      // Clockify has the entry now: persisting it must not depend on the local status, or a retry duplicates it.
      let saved = false;
      try {
        saved = recordSent(db, k, created.id);
      } catch {
        saved = false;
      }
      if (!saved) {
        return {
          key: k,
          ok: false,
          error: { kind: 'state', message: 'Created on Clockify but not saved locally', clockifyId: created.id },
        };
      }
      return { key: k, ok: true, clockifyId: created.id };
    } catch (err) {
      if (err instanceof ClockifyError) return { key: k, ok: false, error: clockifyErrorBody(err) };
      return fail('other', 'Unexpected error while sending');
    } finally {
      inFlight.delete(id);
    }
  }

  // ---------- static ----------
  function serveStatic(req, res, pathname) {
    if (req.method !== 'GET') throw new HttpError(405, 'method', 'Method not allowed');
    const rel = decodeSegment(pathname === '/' ? '/index.html' : pathname);
    if (rel.includes('\0')) throw new HttpError(404, 'notfound', 'Not found');
    const target = path.resolve(uiDir, `.${rel}`);
    if (!target.startsWith(uiDir + path.sep)) throw new HttpError(404, 'notfound', 'Not found');
    let real;
    let realRoot;
    try {
      real = fs.realpathSync(target);
      realRoot = fs.realpathSync(uiDir);
    } catch {
      throw new HttpError(404, 'notfound', 'Not found');
    }
    if (!real.startsWith(realRoot + path.sep) || !fs.statSync(real).isFile()) {
      throw new HttpError(404, 'notfound', 'Not found');
    }
    let data = fs.readFileSync(real);
    const ext = path.extname(real).toLowerCase();
    if (real === path.join(realRoot, 'index.html')) {
      data = Buffer.from(data.toString('utf8').replaceAll('{{SESSION_TOKEN}}', sessionToken));
    }
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Content-Length': data.length,
    });
    res.end(data);
  }

  // ---------- routes ----------
  function allow(req, ...methods) {
    if (!methods.includes(req.method)) throw new HttpError(405, 'method', 'Method not allowed');
  }

  async function route(req, res, url) {
    const segs = url.pathname.split('/').slice(1);
    if (segs[0] !== 'api') return serveStatic(req, res, url.pathname);
    const [, a, b, c, d, ...more] = segs;
    if (more.length) throw new HttpError(404, 'notfound', 'Not found');

    if (a === 'entries' && b === undefined) {
      allow(req, 'GET');
      const filter = {};
      for (const f of ['from', 'to', 'status']) {
        const v = url.searchParams.get(f);
        if (v === null || v === '') continue;
        if (f === 'status' ? !STATUSES.has(v) : !DAY_RE.test(v)) throw bad(`Invalid ${f}`);
        filter[f] = v;
      }
      return sendJson(res, 200, listEntries(db, filter));
    }

    if (a === 'entries' && b === 'send' && c === undefined) {
      allow(req, 'POST');
      const body = await readJson(req);
      if (!isObj(body) || !Array.isArray(body.keys) || body.keys.length === 0) {
        throw bad('Body must be {keys: [{sessionId, startTs}], resend?}');
      }
      if (Object.keys(body).some((k) => k !== 'keys' && k !== 'resend')) throw bad('Unknown field in body');
      if (body.resend !== undefined && typeof body.resend !== 'boolean') throw bad('resend must be a boolean');
      const ctx = clockifyContext();
      const results = [];
      for (const key of body.keys) results.push(await sendOne(key, body.resend === true, ctx));
      broadcast();
      return sendJson(res, 200, { results });
    }

    if (a === 'entries' && b !== undefined && c !== undefined && d === undefined) {
      allow(req, 'PATCH', 'DELETE');
      const key = parseKey(decodeSegment(b), c);
      if (req.method === 'DELETE') {
        req.resume();
        assertNotSending(key);
        const current = rowStatus(db, key);
        if (!current || current === 'dismissed') throw new HttpError(404, 'notfound', 'Entry not found');
        if (current === 'in_progress') {
          throw new HttpError(409, 'state', 'Cannot delete an entry that is in progress; close it first');
        }
        dismissEntry(db, key);
        broadcast();
        return sendJson(res, 200, { deleted: true, key });
      }
      const patch = await readJson(req);
      validatePatch(patch);
      assertNotSending(key);
      const status = rowStatus(db, key);
      if (!status || status === 'dismissed') throw new HttpError(404, 'notfound', 'Entry not found');
      if (status === 'in_progress') throw new HttpError(409, 'state', 'Cannot edit an entry that is in progress');
      const entry = updateEntry(db, key, patch);
      broadcast();
      return sendJson(res, 200, entry);
    }

    if (a === 'entries' && b !== undefined && c !== undefined && d === 'close') {
      allow(req, 'POST');
      const key = parseKey(decodeSegment(b), c);
      req.resume();
      assertNotSending(key);
      const status = rowStatus(db, key);
      if (!status) throw new HttpError(404, 'notfound', 'Entry not found');
      if (status !== 'in_progress') throw new HttpError(409, 'state', 'Only an entry in progress can be closed');
      closeNow(db, key.sessionId, now());
      broadcast();
      return sendJson(res, 200, findEntry(db, key));
    }

    if (a === 'mappings' && b === undefined) {
      allow(req, 'GET', 'PUT', 'DELETE');
      if (req.method === 'GET') return sendJson(res, 200, listMappings(db));
      const body = await readJson(req);
      if (req.method === 'DELETE') {
        if (!isObj(body) || Object.keys(body).some((k) => k !== 'cwd')) throw bad('Body must be {cwd}');
        if (!isNonEmptyStr(body.cwd)) throw bad('cwd is required');
        if (!deleteMapping(db, body.cwd)) throw new HttpError(404, 'not_found', 'Mapping not found');
        broadcast();
        return sendJson(res, 200, listMappings(db));
      }
      if (!isObj(body)) throw bad('Body must be an object');
      if (Object.keys(body).some((k) => !['cwd', 'projectId', 'taskId', 'tagIds'].includes(k))) {
        throw bad('Unknown field in body');
      }
      if (!isNonEmptyStr(body.cwd)) throw bad('cwd is required');
      if (!isNonEmptyStr(body.projectId)) throw bad('projectId is required');
      if (body.taskId !== undefined && !isOptStr(body.taskId)) throw bad('taskId must be a string or null');
      if (body.tagIds !== undefined && !isStrArray(body.tagIds)) throw bad('tagIds must be an array of strings');
      setMapping(db, body.cwd, { projectId: body.projectId, taskId: body.taskId ?? null, tagIds: body.tagIds ?? [] });
      broadcast();
      return sendJson(res, 200, listMappings(db));
    }

    if (a === 'clockify' && ['projects', 'tags', 'tasks'].includes(b) && c === undefined) {
      allow(req, 'GET');
      const projectId = url.searchParams.get('projectId');
      if (b === 'tasks' && !projectId) throw bad('projectId is required');
      const ctx = clockifyContext();
      const cacheName = b === 'tasks' ? `tasks:${projectId}` : b;
      try {
        if (url.searchParams.get('refresh') === '1' || !listCache.has(cacheName)) {
          const ws = await ctx.workspace();
          let list;
          if (b === 'projects') list = await ctx.client.listProjects(ws);
          else if (b === 'tags') list = await ctx.client.listTags(ws);
          else list = await ctx.client.listTasks(ws, projectId);
          listCache.set(cacheName, list);
        }
      } catch (err) {
        if (err instanceof ClockifyError) {
          return sendJson(res, err.kind === 'auth' ? 401 : 502, { error: clockifyErrorBody(err) });
        }
        throw err;
      }
      return sendJson(res, 200, listCache.get(cacheName));
    }

    if (a === 'export' && b === 'status' && c === undefined) {
      allow(req, 'GET');
      const st = loadProfileState();
      const out = { state: st.state, templatePath: st.templatePath ?? null, message: st.message ?? null };
      if (st.state === 'ready') {
        out.sheet = st.profile.sheet;
        out.columns = profileColumns(st.profile);
        out.month = currentMonth(new Date(now()));
      }
      return sendJson(res, 200, out);
    }

    if (a === 'export' && (b === 'preview' || b === 'download') && c === undefined) {
      allow(req, 'POST');
      const body = await readJson(req);
      if (!isObj(body) || Object.keys(body).some((k) => k !== 'month') || !MONTH_RE.test(body.month ?? '')) {
        throw bad('Body must be {month: "YYYY-MM"}');
      }
      const st = loadProfileState();
      if (st.state !== 'ready') {
        throw new HttpError(409, 'state', `Export profile not ready (${st.state}): run /clockify-export in Claude Code`);
      }
      let result;
      try {
        result = await collectMonth({
          client: clockifyContext().client,
          workspaceId: loadConfig().workspaceId,
          month: body.month,
          profile: st.profile,
        });
      } catch (err) {
        if (err instanceof ClockifyError) {
          return sendJson(res, err.kind === 'auth' ? 401 : 502, { error: clockifyErrorBody(err) });
        }
        throw err;
      }
      const { entries, records, totalHours } = result;
      if (b === 'preview') {
        return sendJson(res, 200, {
          month: body.month,
          entries: entries.length,
          rows: rowCount(records),
          totalHours: Math.round(totalHours * 100) / 100,
          columns: profileColumns(st.profile),
          preview: previewTable(records, st.profile, PREVIEW_ROWS),
        });
      }
      if (rowCount(records) === 0) throw new HttpError(409, 'state', 'No entries in that month: nothing to export');
      let file;
      try {
        file = fillTemplate(st.templateBuf, st.profile, records, body.month);
      } catch (err) {
        throw new HttpError(422, 'validation', `The template could not be filled: ${err.message}`);
      }
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'Content-Type': XLSX_MIME,
        'Content-Disposition': `attachment; filename="clockify-${body.month}.xlsx"`,
        'Content-Length': file.length,
      });
      return res.end(file);
    }

    if (a === 'settings' && b === undefined) {
      allow(req, 'GET', 'PUT');
      if (req.method === 'PUT') {
        const patch = validateSettings(await readJson(req));
        saveConfig(patch);
        reconcileAndPush();
      }
      return sendJson(res, 200, publicSettings(loadConfig()));
    }

    if (a === 'import' && b === undefined) {
      allow(req, 'POST');
      const body = (await readJson(req)) ?? {};
      if (typeof body !== 'object' || body === null || Array.isArray(body)) throw bad('Body must be an object');
      if (Object.keys(body).some((k) => !['from', 'to'].includes(k))) throw bad('Unknown field');
      for (const k of ['from', 'to']) {
        if (body[k] !== undefined && body[k] !== null && !Number.isFinite(body[k])) throw bad(`${k} must be a timestamp in ms`);
      }
      const range = { from: body.from ?? -Infinity, to: body.to ?? Infinity };
      if (range.from > range.to) throw bad('from must not be after to');
      const counts = importTranscripts(db, opts.projectsDir, range);
      reconcileAndPush();
      return sendJson(res, 200, counts);
    }

    if (a === 'events' && b === undefined) {
      allow(req, 'GET');
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'Content-Type': 'text/event-stream; charset=utf-8',
        Connection: 'keep-alive',
      });
      sseClients.add(res);
      res.on('close', () => sseClients.delete(res));
      res.write(`event: entries\ndata: ${entriesJson()}\n\n`);
      return undefined;
    }

    throw new HttpError(404, 'notfound', 'Not found');
  }

  const server = http.createServer((req, res) => {
    const verdict = checkRequest(req, sessionToken, port);
    if (!verdict.ok) {
      req.resume();
      return sendError(res, verdict.status, 'forbidden', verdict.reason);
    }
    let url;
    try {
      url = new URL(req.url, 'http://127.0.0.1');
    } catch {
      req.resume();
      return sendError(res, 400, 'validation', 'Malformed URL');
    }
    route(req, res, url).catch((err) => {
      req.resume();
      if (err instanceof HttpError) return sendError(res, err.status, err.kind, err.message);
      return sendError(res, 500, 'internal', 'Internal server error');
    });
    return undefined;
  });

  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(opts.port ?? loadConfig().port, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch (err) {
    clearInterval(timer);
    if (ownDb) db.close();
    throw err;
  }
  port = server.address().port;

  let closed = false;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    sessionToken,
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      for (const res of sseClients) res.end();
      sseClients.clear();
      await new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      if (ownDb) db.close();
    },
  };
}
