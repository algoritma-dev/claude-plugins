// Claude Clockify dashboard. Vanilla JS, no dependencies.
// Security: dynamic data is only ever written via textContent / DOM nodes, never parsed as HTML.
'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const TOKEN = document.querySelector('meta[name="session-token"]')?.getAttribute('content') ?? '';
  const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
  const BASE_TITLE = 'Claude Clockify';
  const SENDABLE = new Set(['proposed', 'edited']);
  const selectable = (e) => e.status !== 'in_progress';
  const STATUS_CLASS = { in_progress: 'st-in-progress', proposed: 'st-proposed', edited: 'st-edited', sent: 'st-sent' };
  const STATUS_LABEL = { in_progress: 'In progress', proposed: 'Proposed', edited: 'Edited', sent: 'Sent' };
  const PROPS = new Set(['value', 'checked', 'disabled', 'hidden', 'selected']);

  // ---------- DOM helper (text only, never HTML) ----------
  function h(tag, props = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'for') el.htmlFor = v;
      else if (PROPS.has(k)) el[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of children.flat()) {
      if (c === null || c === undefined || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  // ---------- formatting ----------
  const pad = (n) => String(n).padStart(2, '0');
  const localDay = (ts) => {
    const d = new Date(ts);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };
  const fmtTime = (ts) => {
    const d = new Date(ts);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  /** Parses 24h times typed as "9", "930", "9:30" or "9.30"; null when invalid. */
  const parseClock = (text) => {
    const t = String(text).trim();
    const m = /^(\d{1,2})(?:[:.]?(\d{2}))?$/.exec(t);
    if (!m) return null;
    const hh = Number(m[1]);
    const mm = Number(m[2] ?? 0);
    if (hh > 23 || mm > 59) return null;
    return { h: hh, m: mm, text: `${pad(hh)}:${pad(mm)}` };
  };
  const hoursInput = (min) => (Number(min) / 60).toFixed(2);
  const fmtHours = (min) => `${(Number(min) / 60).toFixed(2)} h`;
  /** Decimal hours typed by the user: accepts both "1.5" and "1,5". NaN when not a plain number. */
  const parseHours = (text) => {
    const t = String(text).trim().replace(',', '.');
    return /^\d*\.?\d+$|^\d+\.$/.test(t) ? Number(t) : NaN;
  };
  function fmtDay(day) {
    const [y, m, d] = day.split('-').map(Number);
    const s = new Date(y, m - 1, d).toLocaleDateString(undefined, {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    });
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
  const keyOf = (e) => `${e.sessionId}\u0000${e.startTs}`;
  const entryPath = (e) => `/api/entries/${encodeURIComponent(e.sessionId)}/${e.startTs}`;

  // ---------- errors ----------
  class ApiError extends Error {
    constructor(kind, message, status) {
      super(message);
      this.kind = kind;
      this.status = status;
    }
  }
  const KIND_MSG = {
    auth: 'Clockify token invalid or missing: check Settings.',
    rate: 'Too many requests to Clockify: try again in a moment.',
    network: 'Clockify is unreachable: check your connection and try again.',
    validation: 'Invalid data.',
    state: 'Operation not allowed in the entry\'s current status.',
    busy: 'This entry is already being sent.',
    notfound: 'Entry not found: it may have been recomputed. Reload the page.',
    forbidden: 'Request rejected by the local server: reload the page.',
    offline: 'Local server unreachable.',
    too_large: 'Request too large.',
    method: 'Operation not supported.',
    internal: 'Local server internal error.',
    other: 'Unexpected error.',
  };
  const DETAIL = [
    [/no Clockify project/i, 'the Clockify project is missing'],
    [/already sent/i, 'entry already sent, use Resend'],
    [/no Clockify id/i, 'the sent entry has no Clockify id'],
    [/in progress/i, 'the entry is still in progress'],
    [/minutes must/i, 'hours must be greater than 0 and at most 24'],
    [/description must/i, 'description too long (500 characters max)'],
    [/no default workspace/i, 'the Clockify user has no default workspace'],
  ];
  function errText(err) {
    const kind = err?.kind ?? 'other';
    const base = KIND_MSG[kind] ?? KIND_MSG.other;
    if (!['validation', 'state', 'other'].includes(kind) || !err?.message) return base;
    const hit = DETAIL.find(([re]) => re.test(err.message));
    const id = typeof err.clockifyId === 'string' ? `, Clockify id ${err.clockifyId}` : '';
    return `${base} (${hit ? hit[1] : err.message}${id})`;
  }

  // ---------- API ----------
  async function api(method, url, body) {
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (MUTATING.has(method)) headers['X-Session-Token'] = TOKEN;
    let res;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: 'no-store',
        credentials: 'same-origin',
      });
    } catch {
      throw new ApiError('offline', 'fetch failed', 0);
    }
    let data = null;
    const text = await res.text().catch(() => '');
    if (text) {
      try { data = JSON.parse(text); } catch { data = null; }
    }
    if (!res.ok) {
      const e = data && typeof data === 'object' ? data.error : null;
      throw new ApiError(e?.kind ?? 'other', e?.message ?? `HTTP ${res.status}`, res.status);
    }
    return data;
  }

  // ---------- state ----------
  const state = {
    entries: [],
    byKey: new Map(),
    initialized: false,
    projects: null,
    tags: null,
    tasks: new Map(), // projectId -> {list, error, promise}
    forceTaskRefresh: new Set(),
    mappings: [],
    settings: null,
    selected: new Set(),
    filters: { period: '7d', from: '', to: '', status: '' },
  };
  const rowCtl = new Map(); // key -> row controller
  const dayRows = new Map(); // day -> {tr, th}
  const nowItems = new Map(); // key -> {el, ...}

  const projectName = (id) => (id ? state.projects?.find((p) => p.id === id)?.name ?? id : null);
  const taskName = (pid, id) => (id ? state.tasks.get(pid)?.list?.find((t) => t.id === id)?.name ?? id : null);
  const tagName = (id) => state.tags?.find((t) => t.id === id)?.name ?? id;

  // ---------- messages ----------
  function setMsg(el, kind, text, clearAfterMs) {
    el.textContent = text;
    el.className = `msg${kind ? ` msg-${kind}` : ''}`;
    clearTimeout(el.clearTimer);
    if (clearAfterMs) el.clearTimer = setTimeout(() => { el.textContent = ''; }, clearAfterMs);
  }
  let globalRetry = null;
  function showGlobalError(text, retry) {
    $('global-error-text').textContent = text;
    globalRetry = retry;
    $('global-error-retry').hidden = !retry;
    $('global-error').hidden = false;
  }
  function hideGlobalError() {
    $('global-error').hidden = true;
    globalRetry = null;
  }
  function showListsError(err) {
    $('lists-error-text').textContent = `Clockify lists unavailable: ${errText(err)}`;
    $('lists-error').hidden = false;
  }

  // ---------- entries loading ----------
  async function loadEntries() {
    try {
      const list = await api('GET', '/api/entries');
      hideGlobalError();
      setEntries(list);
    } catch (err) {
      showGlobalError(`Could not load entries: ${errText(err)}`, loadEntries);
    }
  }

  function setEntries(list) {
    const prev = state.byKey;
    state.entries = Array.isArray(list) ? list : [];
    state.byKey = new Map(state.entries.map((e) => [keyOf(e), e]));
    if (state.initialized) {
      const newly = state.entries.filter((e) => e.status === 'proposed' && prev.get(keyOf(e))?.status !== 'proposed');
      if (newly.length) showProposedBanner(newly.length);
    }
    state.initialized = true;
    for (const k of state.selected) {
      const e = state.byKey.get(k);
      if (!e || !selectable(e)) state.selected.delete(k);
    }
    render();
  }

  function replaceEntry(updated) {
    if (!updated || typeof updated !== 'object') return;
    const k = keyOf(updated);
    state.entries = state.entries.map((e) => (keyOf(e) === k ? updated : e));
    state.byKey.set(k, updated);
    render();
  }

  function showProposedBanner(n) {
    const total = state.entries.filter((e) => e.status === 'proposed').length;
    $('proposed-banner-text').textContent = n === 1
      ? `One entry is ready to send (${total} proposed in total).`
      : `${n} entries are ready to send (${total} proposed in total).`;
    $('proposed-banner').hidden = false;
  }

  function updateTitle() {
    const n = state.entries.filter((e) => e.status === 'proposed').length;
    document.title = n ? `(${n}) ${BASE_TITLE}` : BASE_TITLE;
  }

  // ---------- Clockify lists ----------
  async function loadLists(refresh = false) {
    const q = refresh ? '?refresh=1' : '';
    $('lists-error').hidden = true;
    try {
      const [projects, tags] = await Promise.all([
        api('GET', `/api/clockify/projects${q}`),
        api('GET', `/api/clockify/tags${q}`),
      ]);
      state.projects = projects;
      state.tags = tags;
      if (refresh) {
        for (const pid of state.tasks.keys()) state.forceTaskRefresh.add(pid);
      }
      state.tasks.clear();
      render();
      renderMappings(false);
      return true;
    } catch (err) {
      showListsError(err);
      render();
      return false;
    }
  }

  function ensureTasks(pid) {
    if (!pid) return Promise.resolve([]);
    const cur = state.tasks.get(pid);
    if (cur) return cur.promise;
    const refresh = state.forceTaskRefresh.delete(pid);
    const slot = { list: null, error: null, promise: null };
    slot.promise = api('GET', `/api/clockify/tasks?projectId=${encodeURIComponent(pid)}${refresh ? '&refresh=1' : ''}`)
      .then((list) => {
        slot.list = list;
        return list;
      })
      .catch((err) => {
        slot.error = err;
        showListsError(err);
        return [];
      })
      .finally(() => {
        render();
        renderMappings(false);
      });
    state.tasks.set(pid, slot);
    return slot.promise;
  }

  // ---------- searchable select ----------
  const norm = (t) => String(t ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const COMBO_MAX = 200;
  let openCombo = null;

  /**
   * A native <select> (kept hidden as the value holder, so `.value`, `.disabled` and 'change' keep working)
   * fronted by a filterable combobox. Returns the select; put `select.wrap` in the DOM.
   */
  function comboSelect(props = {}) {
    const sel = h('select', { tabindex: '-1', 'aria-hidden': 'true', ...props, hidden: true });
    const listId = `combo-${++comboSeq}`;
    const input = h('input', {
      type: 'text', class: 'combo-input', role: 'combobox', autocomplete: 'off', spellcheck: 'false',
      'aria-autocomplete': 'list', 'aria-expanded': 'false', 'aria-controls': listId,
    });
    const list = h('ul', { class: 'combo-list', role: 'listbox', id: listId, hidden: true });
    const wrap = h('div', { class: 'combo' }, input, h('span', { class: 'combo-caret', 'aria-hidden': 'true' }), list, sel);
    let isOpen = false;
    let dirty = false;
    let active = -1;
    let shown = [];

    const label = () => sel.selectedOptions[0]?.text ?? '';
    function syncInput() {
      input.value = label();
      input.classList.toggle('is-empty', !sel.value);
      input.disabled = sel.disabled;
      const al = sel.getAttribute('aria-label');
      if (al) input.setAttribute('aria-label', al);
      wrap.classList.toggle('is-disabled', sel.disabled);
    }
    function paint() {
      const q = dirty ? norm(input.value.trim()) : '';
      const all = [...sel.options].filter((o) => (q ? o.value !== '' && norm(o.text).includes(q) : true));
      shown = all.slice(0, COMBO_MAX);
      const cur = shown.findIndex((o) => o.value === sel.value);
      active = q ? 0 : Math.max(cur, 0);
      list.replaceChildren(...[
        ...shown.map((o, i) => h('li', {
          role: 'option', id: `${listId}-${i}`, class: `combo-opt${o.value === '' ? ' is-empty' : ''}`,
          'aria-selected': String(o.value === sel.value), 'data-i': String(i),
        }, o.text)),
        shown.length === 0 ? h('li', { class: 'combo-none', role: 'presentation' }, 'No results') : null,
        all.length > shown.length ? h('li', { class: 'combo-none', role: 'presentation' }, `${all.length - shown.length} more — keep typing to narrow down`) : null,
      ].filter(Boolean));
      mark();
    }
    function mark() {
      list.querySelectorAll('.combo-opt').forEach((li, i) => li.classList.toggle('is-active', i === active));
      const li = list.children[active];
      if (li?.id) {
        input.setAttribute('aria-activedescendant', li.id);
        li.scrollIntoView({ block: 'nearest' });
      } else input.removeAttribute('aria-activedescendant');
    }
    function place() {
      const r = input.getBoundingClientRect();
      const below = window.innerHeight - r.bottom;
      const h2 = Math.min(280, Math.max(120, below > 180 ? below - 8 : r.top - 8));
      Object.assign(list.style, {
        left: `${r.left}px`, minWidth: `${Math.max(r.width, 180)}px`, maxHeight: `${h2}px`,
        top: below > 180 ? `${r.bottom + 2}px` : '', bottom: below > 180 ? '' : `${window.innerHeight - r.top + 2}px`,
      });
    }
    function open() {
      if (isOpen || sel.disabled) return;
      if (openCombo && openCombo !== api2) openCombo.close();
      isOpen = true;
      openCombo = api2;
      dirty = false;
      list.hidden = false;
      input.setAttribute('aria-expanded', 'true');
      wrap.classList.add('is-open');
      paint();
      place();
      input.select();
    }
    function close() {
      if (!isOpen) return;
      isOpen = false;
      if (openCombo === api2) openCombo = null;
      list.hidden = true;
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
      wrap.classList.remove('is-open');
      syncInput();
    }
    function choose(i) {
      const o = shown[i];
      if (!o) return;
      const changed = sel.value !== o.value;
      sel.value = o.value;
      close();
      if (changed) sel.dispatchEvent(new Event('change', { bubbles: true }));
    }
    const api2 = { close, get open() { return isOpen; }, sync: syncInput, contains: (n) => wrap.contains(n) };

    input.addEventListener('focus', open);
    input.addEventListener('click', open);
    input.addEventListener('blur', close);
    input.addEventListener('input', () => {
      if (!isOpen) open();
      dirty = true;
      paint();
    });
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        ev.preventDefault();
        if (!isOpen) return open();
        if (shown.length) active = (active + (ev.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length;
        mark();
      } else if (ev.key === 'Enter') {
        if (isOpen) { ev.preventDefault(); choose(active); }
      } else if (ev.key === 'Escape') {
        if (isOpen) { ev.preventDefault(); ev.stopPropagation(); close(); }
      } else if (ev.key === 'Tab') close();
    });
    list.addEventListener('mousedown', (ev) => {
      ev.preventDefault();
      const li = ev.target.closest?.('.combo-opt');
      if (li) choose(Number(li.dataset.i));
    });
    list.addEventListener('mousemove', (ev) => {
      const li = ev.target.closest?.('.combo-opt');
      if (li && Number(li.dataset.i) !== active) { active = Number(li.dataset.i); mark(); }
    });
    new MutationObserver(syncInput).observe(sel, { attributes: true, attributeFilter: ['disabled', 'aria-label'] });

    sel.wrap = wrap;
    sel.combo = api2;
    syncInput();
    return sel;
  }
  let comboSeq = 0;
  const closeOnOutsideScroll = (ev) => { if (openCombo && !ev.target.closest?.('.combo-list')) openCombo.close(); };
  window.addEventListener('scroll', closeOnOutsideScroll, true);
  window.addEventListener('resize', () => openCombo?.close());

  // ---------- generic widgets ----------
  function fillSelect(sel, items, value, emptyLabel) {
    const list = Array.isArray(items) ? items : [];
    const extra = value && !list.some((i) => i.id === value) ? value : null;
    const sig = JSON.stringify([emptyLabel, list.map((i) => [i.id, i.name]), extra]);
    const busy = document.activeElement === sel || sel.combo?.open;
    if (sel.sig !== sig && !busy) {
      sel.replaceChildren(
        h('option', { value: '' }, emptyLabel),
        ...list.map((i) => h('option', { value: i.id }, i.name)),
        extra ? h('option', { value: extra }, `unknown (${extra})`) : null,
      );
      sel.sig = sig;
    }
    if (!busy) sel.value = value ?? '';
    sel.combo?.sync();
  }

  function taskOptions(pid) {
    if (!pid) return { items: [], label: '— choose a project first —' };
    const slot = state.tasks.get(pid);
    if (!slot) ensureTasks(pid);
    if (!slot || (!slot.list && !slot.error)) return { items: [], label: 'loading…' };
    if (slot.error) return { items: [], label: '— tasks unavailable —' };
    return { items: slot.list, label: '— no task —' };
  }

  /** Checkbox list inside <details>; keyboard operable. */
  function createTagPicker(label, onChange) {
    const summary = h('summary', {}, '');
    const box = h('div', { class: 'tag-options', role: 'group', 'aria-label': label });
    const search = h('input', { type: 'text', class: 'tag-search', placeholder: 'Search tags…', autocomplete: 'off', 'aria-label': `Search ${label}` });
    const none = h('p', { class: 'muted tag-none', hidden: true }, 'No results');
    const el = h('details', { class: 'tags' }, summary, search, box, none);
    let sig = null;
    function applyFilter() {
      const q = norm(search.value.trim());
      let shown = 0;
      for (const l of box.querySelectorAll('.tag-opt')) {
        const hit = !q || norm(l.textContent).includes(q);
        l.hidden = !hit;
        if (hit) shown++;
      }
      none.hidden = !q || shown > 0 || !box.querySelector('.tag-opt');
    }
    search.addEventListener('input', applyFilter);
    search.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') ev.preventDefault();
      else if (ev.key === 'Escape' && search.value) { ev.stopPropagation(); search.value = ''; applyFilter(); }
    });
    el.addEventListener('toggle', () => {
      if (el.open) search.focus();
      else { search.value = ''; applyFilter(); }
    });
    let current = [];
    function selected() {
      return [...box.querySelectorAll('input[type=checkbox]')].filter((c) => c.checked).map((c) => c.value);
    }
    box.addEventListener('change', () => {
      current = selected();
      summary.textContent = current.length ? current.map(tagName).join(', ') : 'none';
      onChange(current);
    });
    return {
      el,
      get: () => selected(),
      set(tags, ids, disabled) {
        const list = Array.isArray(tags) ? tags : [];
        const extras = (ids ?? []).filter((id) => !list.some((t) => t.id === id));
        const all = [...list, ...extras.map((id) => ({ id, name: `unknown (${id})` }))];
        const focused = el.contains(document.activeElement);
        const newSig = JSON.stringify([all.map((t) => [t.id, t.name]), disabled]);
        if (newSig !== sig && !focused) {
          box.replaceChildren(...(all.length ? all.map((t) => h('label', { class: 'tag-opt' },
            h('input', { type: 'checkbox', value: t.id, disabled }), ` ${t.name}`))
            : [h('span', { class: 'muted' }, state.tags ? 'no tags available' : 'tags not loaded')]));
          sig = newSig;
          applyFilter();
        }
        if (!focused) {
          for (const c of box.querySelectorAll('input[type=checkbox]')) c.checked = (ids ?? []).includes(c.value);
        }
        current = ids ?? [];
        summary.textContent = current.length ? current.map(tagName).join(', ') : 'none';
      },
    };
  }

  // ---------- entry rows ----------
  function createRow(key) {
    const ctl = {
      key, entry: null, local: {}, pending: {}, timer: null, chain: Promise.resolve(), saveFailed: false, sending: false,
    };
    const eff = (f) => (f in ctl.local ? ctl.local[f] : ctl.entry[f]);
    ctl.eff = eff;

    const cb = h('input', { type: 'checkbox' });
    cb.addEventListener('change', () => {
      if (cb.checked) state.selected.add(key);
      else state.selected.delete(key);
      updateSendSelected();
    });

    // Text field so the time is always shown as 24h HH:MM, whatever the browser locale; the native
    // picker (hidden input, opened by the clock button) is only used to choose a time.
    const time = h('input', { type: 'text', class: 'time', inputmode: 'numeric', maxlength: '5', placeholder: 'HH:MM', autocomplete: 'off' });
    const picker = h('input', { type: 'time', class: 'time-native', tabindex: '-1', 'aria-hidden': 'true' });
    const timeBtn = h('button', { type: 'button', class: 'time-btn', title: 'Pick a time', 'aria-label': 'Pick a time' }, '\u{1F550}');
    const commitTime = (text) => {
      const t = parseClock(text);
      if (!t) {
        setMsg(ctl.msg, 'error', 'Invalid time: use 24h HH:MM.');
        return;
      }
      time.value = t.text;
      const d = new Date(eff('startAt'));
      d.setHours(t.h, t.m, 0, 0);
      queuePatch(ctl, { startAt: d.getTime() }, true);
    };
    time.addEventListener('change', () => commitTime(time.value));
    timeBtn.addEventListener('click', () => {
      picker.value = parseClock(time.value)?.text ?? '';
      try { picker.showPicker(); } catch { picker.focus(); }
    });
    picker.addEventListener('change', () => { if (picker.value) commitTime(picker.value); });

    const hours = h('input', { type: 'text', class: 'hours', inputmode: 'decimal', autocomplete: 'off' });
    hours.addEventListener('change', () => {
      const v = parseHours(hours.value);
      if (!Number.isFinite(v) || v <= 0 || v > 24) {
        setMsg(ctl.msg, 'error', 'Invalid hours: enter a number between 0.01 and 24.');
        return;
      }
      queuePatch(ctl, { minutes: Math.max(15, Math.round(v * 4) * 15) }, true);
    });
    const hint = h('span', { class: 'hint' });

    const project = comboSelect({ class: 'project' });
    project.addEventListener('change', () => {
      const pid = project.value || null;
      queuePatch(ctl, { projectId: pid, taskId: null }, true);
      setSendError(ctl, null);
      if (pid) ensureTasks(pid);
      renderRow(ctl);
    });

    const task = comboSelect({ class: 'task' });
    task.addEventListener('change', () => queuePatch(ctl, { taskId: task.value || null }, true));

    const tags = createTagPicker('Tags', (ids) => queuePatch(ctl, { tagIds: ids }, false));

    const desc = h('input', { type: 'text', class: 'desc', maxlength: '500' });
    desc.addEventListener('input', () => queuePatch(ctl, { description: desc.value }, false));
    desc.addEventListener('blur', () => flush(ctl));
    tags.el.addEventListener('focusout', (ev) => {
      if (!tags.el.contains(ev.relatedTarget)) flush(ctl);
    });

    const badge = h('span', { class: 'badge' });
    const sendBtn = h('button', { type: 'button', class: 'send' }, 'Send');
    sendBtn.addEventListener('click', () => sendRow(ctl, false));
    const resendBtn = h('button', { type: 'button', class: 'resend', hidden: true }, 'Resend');
    resendBtn.addEventListener('click', () => {
      // eslint-disable-next-line no-alert
      if (window.confirm('Resend this entry to Clockify? The entry already on Clockify will be updated.')) {
        sendRow(ctl, true);
      }
    });
    const deleteBtn = h('button', { type: 'button', class: 'delete' }, 'Delete');
    deleteBtn.addEventListener('click', () => deleteRow(ctl));
    const msg = h('div', { class: 'msg', role: 'status', 'aria-live': 'polite' });
    const sendErr = h('div', { class: 'row-error', role: 'alert', hidden: true });

    const tr = h('tr', { class: 'entry' },
      h('td', { class: 'c-sel' }, cb),
      h('td', { class: 'c-time' }, h('div', { class: 'time-field' }, time, timeBtn, picker)),
      h('td', { class: 'c-hours' }, hours, hint),
      h('td', { class: 'c-project' }, project.wrap),
      h('td', { class: 'c-task' }, task.wrap),
      h('td', { class: 'c-tags' }, tags.el),
      h('td', { class: 'c-desc' }, desc),
      h('td', { class: 'c-status' }, badge),
      h('td', { class: 'c-actions' }, h('div', { class: 'actions' }, sendBtn, resendBtn, deleteBtn), msg, sendErr));

    Object.assign(ctl, { tr, cb, time, timeBtn, hours, hint, project, task, tags, desc, badge, sendBtn, resendBtn, deleteBtn, msg, sendErr });
    return ctl;
  }

  function queuePatch(ctl, patch, immediate) {
    Object.assign(ctl.local, patch);
    Object.assign(ctl.pending, patch);
    clearTimeout(ctl.timer);
    if (immediate) flush(ctl);
    else ctl.timer = setTimeout(() => flush(ctl), 700);
  }

  function flush(ctl) {
    clearTimeout(ctl.timer);
    ctl.timer = null;
    const patch = ctl.pending;
    if (Object.keys(patch).length === 0) return ctl.chain;
    ctl.pending = {};
    setMsg(ctl.msg, 'info', 'Saving…');
    ctl.chain = ctl.chain.then(async () => {
      const settle = () => {
        for (const [k, v] of Object.entries(patch)) if (ctl.local[k] === v && !(k in ctl.pending)) delete ctl.local[k];
      };
      try {
        const updated = await api('PATCH', entryPath(ctl.entry), patch);
        settle();
        ctl.saveFailed = false;
        setMsg(ctl.msg, 'ok', 'Saved', 2500);
        replaceEntry(updated);
      } catch (err) {
        settle();
        ctl.saveFailed = true;
        setMsg(ctl.msg, 'error', `Edit not saved: ${errText(err)}`);
        render();
      }
    });
    return ctl.chain;
  }

  function setIfIdle(ctl, el, field, value) {
    if (document.activeElement === el || field in ctl.local) return;
    if (el.value !== value) el.value = value;
  }

  function renderRow(ctl) {
    const e = ctl.entry;
    const locked = e.status === 'in_progress';
    const sent = e.status === 'sent';
    const startAt = ctl.eff('startAt');
    const minutes = ctl.eff('minutes');
    const pid = ctl.eff('projectId');
    const ctx = `entry at ${fmtTime(startAt)} on ${e.day}`;
    ctl.tr.className = `entry ${STATUS_CLASS[e.status] ?? ''}`;

    ctl.cb.disabled = !selectable(e);
    ctl.cb.checked = state.selected.has(ctl.key);
    ctl.cb.setAttribute('aria-label', `Select ${ctx}`);

    for (const [el, label] of [[ctl.time, 'Start time'], [ctl.hours, 'Hours'], [ctl.project, 'Project'],
      [ctl.task, 'Task'], [ctl.desc, 'Description']]) {
      el.disabled = locked;
      el.setAttribute('aria-label', `${label}, ${ctx}`);
    }
    ctl.timeBtn.disabled = locked;
    setIfIdle(ctl, ctl.time, 'startAt', fmtTime(startAt));
    setIfIdle(ctl, ctl.hours, 'minutes', hoursInput(minutes));
    ctl.hint.textContent = hoursInput(e.computedMin) !== hoursInput(minutes) ? `computed: ${fmtHours(e.computedMin)}` : '';

    fillSelect(ctl.project, state.projects, pid, state.projects ? '— no project —' : '— projects not loaded —');
    const to = taskOptions(pid);
    fillSelect(ctl.task, to.items, ctl.eff('taskId'), to.label);
    ctl.task.disabled = locked || !pid;
    ctl.tags.set(state.tags, ctl.eff('tagIds'), locked);
    setIfIdle(ctl, ctl.desc, 'description', ctl.eff('description') ?? '');

    ctl.badge.textContent = STATUS_LABEL[e.status] ?? e.status;
    ctl.badge.className = `badge ${STATUS_CLASS[e.status] ?? ''}`;

    ctl.sendBtn.disabled = locked || sent || ctl.sending;
    ctl.sendBtn.textContent = ctl.sending && !sent ? 'Sending…' : 'Send';
    ctl.sendBtn.title = locked ? 'The entry is still in progress' : sent ? 'Entry already sent' : '';
    ctl.resendBtn.hidden = !sent;
    ctl.resendBtn.disabled = ctl.sending;
    ctl.resendBtn.textContent = ctl.sending && sent ? 'Sending…' : 'Resend';
    ctl.deleteBtn.disabled = locked || ctl.sending;
    ctl.deleteBtn.title = locked ? 'Close the entry first, then delete it' : 'Remove this entry from the dashboard';
  }

  function setSendError(ctl, text) {
    ctl.sendErr.textContent = text ?? '';
    ctl.sendErr.hidden = !text;
  }

  async function sendKeys(ctls, resend) {
    for (const c of ctls) {
      c.sending = true;
      setSendError(c, null);
      renderRow(c);
    }
    let results;
    try {
      const res = await api('POST', '/api/entries/send', {
        keys: ctls.map((c) => ({ sessionId: c.entry.sessionId, startTs: c.entry.startTs })),
        ...(resend ? { resend: true } : {}),
      });
      results = Array.isArray(res?.results) ? res.results : [];
    } catch (err) {
      results = ctls.map((c) => ({ key: { sessionId: c.entry.sessionId, startTs: c.entry.startTs }, ok: false, error: err }));
    }
    let ok = 0;
    for (const c of ctls) {
      c.sending = false;
      const r = results.find((x) => x?.key?.sessionId === c.entry.sessionId && x?.key?.startTs === c.entry.startTs);
      if (r?.ok) {
        ok += 1;
        state.selected.delete(c.key);
        setSendError(c, null);
      } else {
        setSendError(c, `Send failed: ${errText(r?.error ?? { kind: 'other' })}`);
      }
    }
    await loadEntries();
    return { ok, failed: ctls.length - ok };
  }

  async function deleteRow(ctl) {
    if (ctl.sending || ctl.entry.status === 'in_progress') return;
    const warning = ctl.entry.status === 'sent'
      ? 'Delete this entry from the dashboard? It has already been sent: the entry on Clockify is NOT removed.'
      : 'Delete this entry? This cannot be undone.';
    // eslint-disable-next-line no-alert
    if (!window.confirm(warning)) return;
    clearTimeout(ctl.timer);
    ctl.timer = null;
    ctl.pending = {};
    ctl.deleteBtn.disabled = true;
    try {
      await ctl.chain;
      await api('DELETE', entryPath(ctl.entry));
      state.selected.delete(ctl.key);
      await loadEntries();
    } catch (err) {
      setSendError(ctl, `Delete failed: ${errText(err)}`);
      renderRow(ctl);
    }
  }

  async function sendRow(ctl, resend) {
    if (ctl.sending) return;
    await flush(ctl);
    if (ctl.saveFailed) {
      setSendError(ctl, 'Send cancelled: fix the unsaved edit first.');
      return;
    }
    if (!ctl.entry.projectId) {
      setSendError(ctl, 'Cannot send: choose a project.');
      return;
    }
    await sendKeys([ctl], resend);
  }

  // ---------- filters & table ----------
  function inFilter(e) {
    const f = state.filters;
    if (f.status && e.status !== f.status) return false;
    const now = new Date();
    if (f.period === 'today') return e.day === localDay(now.getTime());
    if (f.period === '7d') {
      return e.day >= localDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6).getTime());
    }
    if (f.period === 'range') return (!f.from || e.day >= f.from) && (!f.to || e.day <= f.to);
    return true;
  }

  function render() {
    updateTitle();
    renderNow();
    renderTable();
    updateSendSelected();
  }

  function renderTable() {
    const tbody = $('entries-body');
    const visible = state.entries.filter(inFilter);
    const byDay = new Map();
    for (const e of visible) {
      if (!byDay.has(e.day)) byDay.set(e.day, []);
      byDay.get(e.day).push(e);
    }
    const days = [...byDay.keys()].sort().reverse();
    const desired = [];
    const keepRows = new Set();
    const keepDays = new Set();
    for (const day of days) {
      const list = byDay.get(day).sort((a, b) => a.startAt - b.startAt || a.startTs - b.startTs);
      let dr = dayRows.get(day);
      if (!dr) {
        const th = h('th', { colspan: '9', scope: 'colgroup' });
        dr = { tr: h('tr', { class: 'day' }, th), th };
        dayRows.set(day, dr);
      }
      const total = list.reduce((s, e) => s + Number(e.minutes || 0), 0);
      dr.th.replaceChildren(h('span', { class: 'day-name' }, fmtDay(day)),
        h('span', { class: 'day-total' }, `Total: ${fmtHours(total)}`));
      desired.push(dr.tr);
      keepDays.add(day);
      for (const e of list) {
        const k = keyOf(e);
        let ctl = rowCtl.get(k);
        if (!ctl) {
          ctl = createRow(k);
          rowCtl.set(k, ctl);
        }
        ctl.entry = e;
        renderRow(ctl);
        desired.push(ctl.tr);
        keepRows.add(k);
      }
    }
    // Keyed reorder: only move nodes that are out of place, so a focused input is not detached.
    let ref = tbody.firstChild;
    for (const node of desired) {
      if (node === ref) ref = ref.nextSibling;
      else tbody.insertBefore(node, ref);
    }
    while (ref) {
      const next = ref.nextSibling;
      ref.remove();
      ref = next;
    }
    for (const [k, ctl] of rowCtl) {
      if (!keepRows.has(k) && !state.byKey.has(k)) {
        clearTimeout(ctl.timer);
        rowCtl.delete(k);
      }
    }
    for (const d of dayRows.keys()) if (!keepDays.has(d)) dayRows.delete(d);
    $('entries-empty').hidden = visible.length > 0;
  }

  function updateSendSelected() {
    const btn = $('send-selected');
    const n = state.selected.size;
    btn.disabled = n === 0;
    btn.textContent = n ? `Send selected (${n})` : 'Send selected';
    const del = $('delete-selected');
    del.disabled = n === 0;
    del.textContent = n ? `Delete selected (${n})` : 'Delete selected';
    const vis = state.entries.filter((e) => inFilter(e) && selectable(e));
    const picked = vis.filter((e) => state.selected.has(keyOf(e))).length;
    const all = $('select-all');
    all.disabled = vis.length === 0;
    all.checked = vis.length > 0 && picked === vis.length;
    all.indeterminate = picked > 0 && picked < vis.length;
  }

  function toggleSelectAll() {
    const vis = state.entries.filter((e) => inFilter(e) && selectable(e));
    for (const e of vis) {
      if ($('select-all').checked) state.selected.add(keyOf(e));
      else state.selected.delete(keyOf(e));
    }
    for (const ctl of rowCtl.values()) ctl.cb.checked = state.selected.has(ctl.key);
    updateSendSelected();
  }

  async function deleteSelected() {
    const ctls = [...state.selected].map((k) => rowCtl.get(k)).filter((c) => c && !c.sending && selectable(c.entry));
    if (!ctls.length) return;
    const sent = ctls.filter((c) => c.entry.status === 'sent').length;
    const warning = `Delete ${ctls.length} ${ctls.length === 1 ? 'entry' : 'entries'}? This cannot be undone.`
      + (sent ? `\n${sent} already sent: the entries on Clockify are NOT removed.` : '');
    // eslint-disable-next-line no-alert
    if (!window.confirm(warning)) return;
    const btn = $('delete-selected');
    btn.disabled = true;
    let failed = 0;
    for (const ctl of ctls) {
      clearTimeout(ctl.timer);
      ctl.timer = null;
      ctl.pending = {};
      try {
        await ctl.chain;
        await api('DELETE', entryPath(ctl.entry));
        state.selected.delete(ctl.key);
      } catch (err) {
        failed += 1;
        setSendError(ctl, `Delete failed: ${errText(err)}`);
      }
    }
    await loadEntries();
    setMsg($('send-msg'), failed ? 'error' : 'ok', failed ? `${failed} of ${ctls.length} could not be deleted.` : `Deleted ${ctls.length}.`, failed ? 0 : 2500);
  }

  // ---------- "Now" ----------
  function elapsedText(e) {
    const min = Math.max(0, Math.floor((Date.now() - e.startTs) / 60000));
    const hh = Math.floor(min / 60);
    return hh ? `${hh} h ${min % 60} min` : `${min} min`;
  }

  function renderNow() {
    const box = $('now-list');
    const live = state.entries.filter((e) => e.status === 'in_progress');
    if (!live.length) {
      nowItems.clear();
      if (!box.querySelector('.now-empty')) box.replaceChildren(h('p', { class: 'muted now-empty' }, 'No activity in progress'));
      return;
    }
    box.querySelector('.now-empty')?.remove();
    const keep = new Set();
    for (const e of live) {
      const k = keyOf(e);
      keep.add(k);
      let it = nowItems.get(k);
      if (!it) {
        const title = h('strong', { class: 'now-project' });
        const cwd = h('span', { class: 'now-cwd muted' });
        const since = h('span', { class: 'now-since' });
        const elapsed = h('span', { class: 'now-elapsed' });
        const btn = h('button', { type: 'button', class: 'primary' }, 'Close now');
        const msg = h('span', { class: 'msg', role: 'status', 'aria-live': 'polite' });
        const el = h('div', { class: 'now-item' },
          h('div', { class: 'now-main' }, title, cwd),
          h('div', { class: 'now-time' }, since, elapsed),
          h('div', { class: 'now-actions' }, btn, msg));
        it = { el, title, cwd, since, elapsed, btn, msg, entry: e };
        btn.addEventListener('click', () => closeNowEntry(it));
        nowItems.set(k, it);
        box.append(el);
      }
      it.entry = e;
      const pname = projectName(e.projectId);
      it.title.textContent = pname ?? e.cwd;
      it.cwd.textContent = pname ? e.cwd : 'no project assigned';
      it.since.textContent = `since ${fmtTime(e.startTs)} · `;
      it.elapsed.textContent = elapsedText(e);
      it.btn.setAttribute('aria-label', `Close now the activity in ${e.cwd}`);
    }
    for (const [k, it] of nowItems) {
      if (!keep.has(k)) {
        it.el.remove();
        nowItems.delete(k);
      }
    }
  }

  async function closeNowEntry(it) {
    it.btn.disabled = true;
    setMsg(it.msg, 'info', 'Closing…');
    try {
      await api('POST', `${entryPath(it.entry)}/close`);
      setMsg(it.msg, 'ok', 'Closed');
      await loadEntries();
    } catch (err) {
      setMsg(it.msg, 'error', `Not closed: ${errText(err)}`);
    } finally {
      it.btn.disabled = false;
    }
  }

  // ---------- "Send selected" ----------
  let pendingBatch = null;
  async function openSendDialog() {
    const ctls = [...state.selected].map((k) => rowCtl.get(k)).filter(Boolean);
    await Promise.all(ctls.map((c) => flush(c)));
    const candidates = ctls.filter((c) => SENDABLE.has(c.entry.status));
    // rows whose last edit was not saved would be sent with stale values: exclude them, visibly
    const unsaved = candidates.filter((c) => c.saveFailed);
    for (const c of unsaved) setSendError(c, 'Excluded from sending: fix the unsaved edit first.');
    const excluded = unsaved.length
      ? `${unsaved.length} ${unsaved.length === 1 ? 'entry' : 'entries'} excluded: unsaved edit.`
      : '';
    const sendable = candidates.filter((c) => !c.saveFailed);
    if (!sendable.length) {
      setMsg($('send-msg'), 'error', excluded ? `No entry can be sent. ${excluded}` : 'None of the selected entries can be sent.');
      return;
    }
    if (excluded) setMsg($('send-msg'), 'error', excluded);
    const total = sendable.reduce((s, c) => s + Number(c.entry.minutes || 0), 0);
    $('send-dialog-summary').textContent = `${sendable.length} ${sendable.length === 1 ? 'entry' : 'entries'}, total ${fmtHours(total)}.${excluded ? ` ${excluded}` : ''}`;
    $('send-dialog-list').replaceChildren(...sendable.map((c) => {
      const e = c.entry;
      const p = projectName(e.projectId);
      const t = taskName(e.projectId, e.taskId);
      return h('li', { class: p ? '' : 'warn' },
        `${e.day} ${fmtTime(e.startAt)} · ${p ?? 'project missing'}${t ? ` / ${t}` : ''} · ${fmtHours(e.minutes)}`);
    }));
    pendingBatch = sendable;
    $('send-dialog').showModal();
    $('send-dialog-cancel').focus();
  }

  async function confirmSendDialog() {
    const batch = pendingBatch;
    pendingBatch = null;
    $('send-dialog').close();
    if (!batch?.length) return;
    setMsg($('send-msg'), 'info', 'Sending…');
    const { ok, failed } = await sendKeys(batch, false);
    setMsg($('send-msg'), failed ? 'error' : 'ok',
      failed ? `Sent ${ok}, failed ${failed}: see the messages in the rows.` : `Sent ${ok} ${ok === 1 ? 'entry' : 'entries'}.`);
  }

  // ---------- Mappings ----------
  async function loadMappings() {
    try {
      const list = await api('GET', '/api/mappings');
      state.mappings = Array.isArray(list) ? list : [];
      hideGlobalError();
      renderMappings(true);
    } catch (err) {
      showGlobalError(`Could not load mappings: ${errText(err)}`, loadMappings);
    }
  }

  const mapRows = [];
  function createMappingRow(m, isNew) {
    const r = { projectId: m?.projectId ?? null, taskId: m?.taskId ?? null, tagIds: m?.tagIds ?? [] };
    const label = isNew ? 'new mapping' : `folder ${m.cwd}`;
    const cwdCell = isNew
      ? h('input', { type: 'text', class: 'cwd-input', list: 'cwd-suggestions', placeholder: '/path/to/folder', 'aria-label': 'Folder of the new mapping' })
      : h('code', { class: 'cwd' }, m.cwd);
    const project = comboSelect({ 'aria-label': `Project, ${label}` });
    const task = comboSelect({ 'aria-label': `Task, ${label}` });
    const tags = createTagPicker(`Tags, ${label}`, (ids) => { r.tagIds = ids; });
    const save = h('button', { type: 'button', class: 'primary' }, isNew ? 'Add' : 'Save');
    const msg = h('span', { class: 'msg', role: 'status', 'aria-live': 'polite' });
    const remove = isNew ? null : h('button', { type: 'button', class: 'delete', title: 'Remove this mapping' }, 'Remove');
    r.tr = h('tr', { class: isNew ? 'new-mapping' : '' },
      h('td', {}, cwdCell), h('td', {}, project.wrap), h('td', {}, task.wrap), h('td', {}, tags.el), h('td', {}, save, remove, msg));
    r.render = () => {
      fillSelect(project, state.projects, r.projectId, state.projects ? '— choose a project —' : '— projects not loaded —');
      const to = taskOptions(r.projectId);
      fillSelect(task, to.items, r.taskId, to.label);
      task.disabled = !r.projectId;
      tags.set(state.tags, r.tagIds, false);
    };
    project.addEventListener('change', () => {
      r.projectId = project.value || null;
      r.taskId = null;
      if (r.projectId) ensureTasks(r.projectId);
      r.render();
    });
    task.addEventListener('change', () => { r.taskId = task.value || null; });
    save.addEventListener('click', async () => {
      const cwd = isNew ? cwdCell.value.trim() : m.cwd;
      if (!cwd) return setMsg(msg, 'error', 'Enter the folder.');
      if (!r.projectId) return setMsg(msg, 'error', 'Choose a project.');
      save.disabled = true;
      setMsg(msg, 'info', 'Saving…');
      try {
        const list = await api('PUT', '/api/mappings', { cwd, projectId: r.projectId, taskId: r.taskId, tagIds: r.tagIds });
        state.mappings = Array.isArray(list) ? list : state.mappings;
        if (isNew) renderMappings(true);
        else setMsg(msg, 'ok', 'Saved', 2500);
      } catch (err) {
        setMsg(msg, 'error', `Not saved: ${errText(err)}`);
      } finally {
        save.disabled = false;
      }
      return undefined;
    });
    remove?.addEventListener('click', async () => {
      // eslint-disable-next-line no-alert
      if (!window.confirm(`Remove the mapping for ${m.cwd}? Existing entries keep their values.`)) return;
      remove.disabled = true;
      save.disabled = true;
      try {
        const list = await api('DELETE', '/api/mappings', { cwd: m.cwd });
        state.mappings = Array.isArray(list) ? list : state.mappings;
        renderMappings(true);
      } catch (err) {
        remove.disabled = false;
        save.disabled = false;
        setMsg(msg, 'error', `Not removed: ${errText(err)}`);
      }
    });
    r.render();
    return r;
  }

  /** rebuild=true recreates rows from state.mappings; false only refreshes option lists. */
  function renderMappings(rebuild) {
    if (!rebuild) {
      for (const r of mapRows) r.render();
      return;
    }
    mapRows.length = 0;
    for (const m of state.mappings) mapRows.push(createMappingRow(m, false));
    mapRows.push(createMappingRow(null, true));
    $('mappings-body').replaceChildren(...mapRows.map((r) => r.tr));
    const mapped = new Set(state.mappings.map((m) => m.cwd));
    const cwds = [...new Set(state.entries.map((e) => e.cwd))].filter((c) => !mapped.has(c)).sort();
    $('cwd-suggestions').replaceChildren(...cwds.map((c) => h('option', { value: c })));
  }

  // ---------- Settings ----------
  function renderSettings() {
    const s = state.settings;
    if (!s) return;
    $('s-threshold').value = String(s.thresholdMin ?? '');
    $('s-margin').value = String(s.marginMin ?? '');
    $('s-workspace').value = s.workspaceId ?? '';
    $('s-port').value = String(s.port ?? '');
    $('s-token').value = '';
    const st = $('s-token-state');
    st.textContent = s.tokenSet ? 'set' : 'not set';
    st.className = `pill ${s.tokenSet ? 'pill-ok' : 'pill-warn'}`;
    $('s-token-remove').disabled = !s.tokenSet;
  }

  async function loadSettings() {
    try {
      state.settings = await api('GET', '/api/settings');
      hideGlobalError();
      renderSettings();
    } catch (err) {
      showGlobalError(`Could not load settings: ${errText(err)}`, loadSettings);
    }
  }

  async function putSettings(body, okText) {
    const msg = $('settings-msg');
    setMsg(msg, 'info', 'Saving…');
    try {
      const before = state.settings;
      state.settings = await api('PUT', '/api/settings', body);
      renderSettings();
      setMsg(msg, 'ok', okText, 4000);
      if (body.clockifyToken !== undefined || (body.workspaceId ?? null) !== (before?.workspaceId ?? null)) {
        state.tasks.clear();
        loadLists(false);
      }
    } catch (err) {
      setMsg(msg, 'error', `Settings not saved: ${errText(err)}`);
    }
  }

  function onSettingsSubmit(ev) {
    ev.preventDefault();
    const num = (id) => $(id).valueAsNumber;
    const thresholdMin = num('s-threshold');
    const marginMin = num('s-margin');
    const port = num('s-port');
    const msg = $('settings-msg');
    if (!Number.isFinite(thresholdMin) || thresholdMin <= 0) return setMsg(msg, 'error', 'The threshold must be a number greater than 0.');
    if (!Number.isFinite(marginMin) || marginMin < 0) return setMsg(msg, 'error', 'The margin must be a number greater than or equal to 0.');
    if (!Number.isInteger(port) || port < 1 || port > 65535) return setMsg(msg, 'error', 'The port must be an integer between 1 and 65535.');
    const body = { thresholdMin, marginMin, port, workspaceId: $('s-workspace').value.trim() || null };
    const token = $('s-token').value.trim();
    if (token) body.clockifyToken = token; // empty field = leave unchanged
    putSettings(body, port !== state.settings?.port
      ? 'Settings saved. The new port will be used at the next start.'
      : 'Settings saved.');
    return undefined;
  }

  function onRemoveToken() {
    // eslint-disable-next-line no-alert
    if (!window.confirm('Remove the saved Clockify token?')) return;
    putSettings({ clockifyToken: '' }, 'Token removed.');
  }

  /** Period selected next to the import button, as epoch-ms bounds in local time. */
  function importRange() {
    const kind = $('import-period').value;
    const now = new Date();
    const dayStart = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const dayEnd = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime() - 1;
    if (kind === 'today') return { body: { from: dayStart(now), to: dayEnd(now) } };
    if (kind === '7d') return { body: { from: dayStart(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6)), to: dayEnd(now) } };
    if (kind === 'range') {
      const parse = (v) => (v ? new Date(`${v}T00:00:00`) : null);
      const f = parse($('import-from').value);
      const t = parse($('import-to').value);
      if (!f && !t) return { error: 'Choose at least one date.' };
      if (f && t && f > t) return { error: '"From" must not be after "To".' };
      return { body: { ...(f && { from: dayStart(f) }), ...(t && { to: dayEnd(t) }) } };
    }
    return { body: undefined };
  }

  async function onImport() {
    const btn = $('btn-import');
    const msg = $('tools-msg');
    const range = importRange();
    if (range.error) return setMsg(msg, 'error', range.error);
    btn.disabled = true;
    setMsg(msg, 'info', 'Importing…');
    try {
      const r = await api('POST', '/api/import', range.body);
      setMsg(msg, 'ok', `Import complete: ${r?.files ?? 0} files read, ${r?.inserted ?? 0} new events, ${r?.skipped ?? 0} invalid lines skipped.`);
      await loadEntries();
    } catch (err) {
      setMsg(msg, 'error', `Import failed: ${errText(err)}`);
    } finally {
      btn.disabled = false;
    }
  }

  async function onRefreshLists() {
    const btn = $('btn-refresh-lists');
    const msg = $('tools-msg');
    btn.disabled = true;
    setMsg(msg, 'info', 'Refreshing lists…');
    const ok = await loadLists(true);
    setMsg(msg, ok ? 'ok' : 'error', ok ? 'Clockify lists refreshed.' : 'Refresh failed: see the message in the Entries tab.');
    btn.disabled = false;
  }

  // ---------- Export ----------
  const XSTATE = {
    ready: ['pill-ok', 'Profile ready'],
    missing: ['pill-warn', 'No profile yet'],
    invalid: ['pill-warn', 'Profile invalid'],
    template_missing: ['pill-warn', 'Template not found'],
    template_changed: ['pill-warn', 'Template changed'],
  };
  const xState = { ready: false };

  async function loadExport() {
    try {
      const st = await api('GET', '/api/export/status');
      const [cls, label] = XSTATE[st.state] ?? ['pill-warn', st.state];
      $('x-state').textContent = label;
      $('x-state').className = `pill ${cls}`;
      $('x-detail').textContent = st.state === 'ready'
        ? `Sheet "${st.sheet}" of ${st.templatePath}`
        : (st.message ?? st.templatePath ?? '');
      xState.ready = st.state === 'ready';
      $('x-setup').hidden = xState.ready;
      $('x-controls').hidden = !xState.ready;
      if (xState.ready && !$('x-month').value) $('x-month').value = st.month;
    } catch (err) {
      $('x-state').textContent = 'Unavailable';
      $('x-state').className = 'pill pill-warn';
      $('x-detail').textContent = `Could not load export status: ${errText(err)}. If you just updated the plugin, restart the dashboard.`;
    }
  }

  async function onExportPreview() {
    const month = $('x-month').value;
    const msg = $('x-msg');
    if (!month) return setMsg(msg, 'error', 'Choose a month.');
    setMsg(msg, 'info', 'Reading Clockify…');
    try {
      const r = await api('POST', '/api/export/preview', { month });
      $('x-head').replaceChildren(...r.columns.map((c) => h('th', { scope: 'col' }, c)));
      $('x-body').replaceChildren(...r.preview.map((row) => h('tr', {}, ...row.map((v) => h('td', {}, v)))));
      const more = r.rows > r.preview.length ? ` (first ${r.preview.length} shown)` : '';
      $('x-summary').textContent = `${r.entries} entries -> ${r.rows} rows, ${r.totalHours.toFixed(2)} h${more}`;
      $('x-result').hidden = false;
      setMsg(msg, '', '');
    } catch (err) {
      setMsg(msg, 'error', `Preview failed: ${errText(err)}`);
    }
  }

  async function onExportDownload() {
    const month = $('x-month').value;
    const msg = $('x-msg');
    if (!month) return setMsg(msg, 'error', 'Choose a month.');
    const btn = $('x-download');
    btn.disabled = true;
    setMsg(msg, 'info', 'Building the file…');
    try {
      let res;
      try {
        res = await fetch('/api/export/download', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Session-Token': TOKEN },
          body: JSON.stringify({ month }),
          cache: 'no-store',
          credentials: 'same-origin',
        });
      } catch {
        throw new ApiError('offline', 'fetch failed', 0);
      }
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new ApiError(data?.error?.kind ?? 'other', data?.error?.message ?? `HTTP ${res.status}`, res.status);
      }
      const url = URL.createObjectURL(await res.blob());
      const a = h('a', { href: url, download: `clockify-${month}.xlsx` });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      setMsg(msg, 'ok', 'File downloaded.');
    } catch (err) {
      setMsg(msg, 'error', `Export failed: ${errText(err)}`);
    } finally {
      btn.disabled = false;
    }
  }

  // ---------- tabs ----------
  const TABS = ['entries', 'mappings', 'export', 'settings'];
  function selectTab(name, focus) {
    for (const t of TABS) {
      const tab = $(`tab-${t}`);
      const on = t === name;
      tab.setAttribute('aria-selected', String(on));
      tab.tabIndex = on ? 0 : -1;
      $(`panel-${t}`).hidden = !on;
      if (on && focus) tab.focus();
    }
    if (name === 'mappings') loadMappings();
    if (name === 'export') loadExport();
    if (name === 'settings') loadSettings();
  }

  // ---------- live updates ----------
  function connectEvents() {
    const es = new EventSource('/api/events');
    const conn = $('conn-status');
    es.addEventListener('entries', (ev) => {
      let list;
      try { list = JSON.parse(ev.data); } catch { return; }
      setEntries(list);
    });
    es.addEventListener('open', () => {
      conn.textContent = '';
      conn.className = 'conn';
    });
    es.addEventListener('error', () => {
      conn.textContent = 'Live updates interrupted: reconnecting…';
      conn.className = 'conn conn-lost';
    });
  }

  // ---------- wiring ----------
  function init() {
    for (const t of TABS) {
      const tab = $(`tab-${t}`);
      tab.addEventListener('click', () => selectTab(t, false));
      tab.addEventListener('keydown', (ev) => {
        const i = TABS.indexOf(t);
        let j = null;
        if (ev.key === 'ArrowRight') j = (i + 1) % TABS.length;
        else if (ev.key === 'ArrowLeft') j = (i + TABS.length - 1) % TABS.length;
        else if (ev.key === 'Home') j = 0;
        else if (ev.key === 'End') j = TABS.length - 1;
        if (j !== null) {
          ev.preventDefault();
          selectTab(TABS[j], true);
        }
      });
    }
    const period = $('f-period');
    period.addEventListener('change', () => {
      state.filters.period = period.value;
      const range = period.value === 'range';
      $('f-from-wrap').hidden = !range;
      $('f-to-wrap').hidden = !range;
      renderTable();
    });
    $('f-from').addEventListener('change', () => { state.filters.from = $('f-from').value; renderTable(); });
    $('f-to').addEventListener('change', () => { state.filters.to = $('f-to').value; renderTable(); });
    $('f-status').addEventListener('change', () => { state.filters.status = $('f-status').value; renderTable(); });
    $('send-selected').addEventListener('click', openSendDialog);
    $('delete-selected').addEventListener('click', deleteSelected);
    $('select-all').addEventListener('change', toggleSelectAll);
    $('send-dialog-cancel').addEventListener('click', () => { pendingBatch = null; $('send-dialog').close(); });
    $('send-dialog').addEventListener('cancel', () => { pendingBatch = null; });
    $('send-dialog-confirm').addEventListener('click', confirmSendDialog);
    $('proposed-banner-close').addEventListener('click', () => { $('proposed-banner').hidden = true; });
    $('global-error-retry').addEventListener('click', () => { if (globalRetry) globalRetry(); });
    $('lists-error-retry').addEventListener('click', () => loadLists(false));
    $('settings-form').addEventListener('submit', onSettingsSubmit);
    $('s-token-remove').addEventListener('click', onRemoveToken);
    $('btn-import').addEventListener('click', onImport);
    $('import-period').addEventListener('change', () => {
      const custom = $('import-period').value === 'range';
      $('import-from-wrap').hidden = !custom;
      $('import-to-wrap').hidden = !custom;
    });
    $('btn-refresh-lists').addEventListener('click', onRefreshLists);
    $('x-preview').addEventListener('click', onExportPreview);
    $('x-download').addEventListener('click', onExportDownload);

    if (!/^[A-Za-z0-9+/=_-]{32,}$/.test(TOKEN)) {
      showGlobalError('Session token missing: open the dashboard from the local server.', null);
    }
    setInterval(() => {
      for (const it of nowItems.values()) it.elapsed.textContent = elapsedText(it.entry);
    }, 15000);

    render();
    loadEntries();
    loadLists(false);
    loadSettings();
    connectEvents();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
