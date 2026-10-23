/* Experiment Roadmap — the deployed app.
   Components and rules come from window.Roadmap (bundle.js, the design system). This file adds
   storage: each person's board lives in the artifact's db under data/users/<their id>/, cached in
   this browser, and changes queue in an outbox so nothing is lost while offline. */
(function () {
  'use strict';
  var R = window.React, h = R.createElement, RM = window.Roadmap, U = RM.utils;
  var N_DAYS = 14;        // days in the export picker
  var RANGE_LEAD = 28;    // days rendered before this week's Monday on load
  var RANGE_INITIAL = 112;
  var RANGE_CHUNK = 28;   // days added when you scroll near either end
  var RANGE_MAX = 224;    // beyond this, days far off the other side are dropped
  var RANGE_EDGE = 10;    // extend when fewer than this many days remain past the edge of the view
  var DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var MONL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  var DENSITY = { compact: 168, comfortable: 200, roomy: 240 };
  var EXPORT_DEFAULTS = { group: 'day', format: 'md', includeOpen: false, includeNotes: true, includeDesk: true };
  // Steps start without a category (an experiment spans many kinds of work); set one per step later.
  var NO_CAT = { id: 'none', name: 'No category', tag: '··', color: 'var(--ink-2)', group: 'bench' };
  var MOD = /Mac|iPhone|iPad/.test(navigator.platform || '') ? '⌘' : 'Ctrl+';
  // Pointer-downs on these keep the current selection; anywhere else counts as a click on empty space.
  var KEEP_SELECTION = '.rm-pop, .rm-plan, .rm-ghost, .rm-gname, .rm-selbar, .rm-toast, .rm-addform, .rm-cell-tool, .rm-resize, .rm-note, .rm-palette, button, input, select, textarea, label';

  // ---------- helpers ----------
  function todayIso() { return U.iso(new Date()); }
  function monthKey(date) { return date.slice(0, 7); }
  function newId(prefix) { return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
  // Same semantics as db update(): nested objects merge, anything else replaces. With drop, null deletes the key.
  function merge(a, b, drop) {
    var out = Object.assign({}, a);
    Object.keys(b).forEach(function (k) {
      var v = b[k];
      if (v === null && drop) delete out[k];
      else if (isObj(v)) out[k] = merge(isObj(out[k]) ? out[k] : {}, v, drop);
      else out[k] = v;
    });
    return out;
  }
  function values(o) { return Object.keys(o || {}).map(function (k) { return o[k]; }).filter(isObj); }
  function byOrder(a, b) { return (a.order || 0) - (b.order || 0); }
  function stop(e) { e.stopPropagation(); }
  var LS = {
    get: function (k) { try { var v = window.localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch (e) { return null; } },
    set: function (k, v) { try { window.localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  };
  function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text).catch(function () { legacyCopy(text); });
    } catch (e) {}
    legacyCopy(text);
  }
  function legacyCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch (e) {}
    ta.remove();
  }

  // ---------- data model ----------
  var DEFAULT_CATS = RM.CATEGORIES.map(function (c, i) { return Object.assign({}, c, { order: i }); });
  function defaultMeta() {
    var cats = {};
    DEFAULT_CATS.forEach(function (c) { cats[c.id] = c; });
    return {
      v: 1, cats: cats, prefs: {},
      exps: { desk: { id: 'desk', name: 'Desk & meetings', color: 'var(--exp-desk)', desk: true, order: 0 } }
    };
  }
  // Documents: meta {cats, exps, prefs}, plans-YYYY-MM {plans: {id: Plan|null}}, notes-YYYY-MM {notes: {date: text}}
  function derive(docs) {
    var meta = docs.meta;
    var cats = meta ? values(meta.cats).sort(byOrder) : DEFAULT_CATS;
    var exps = meta ? values(meta.exps).sort(function (a, b) { return ((b.desk ? 1 : 0) - (a.desk ? 1 : 0)) || byOrder(a, b); }) : [];
    var plans = [], notes = {};
    Object.keys(docs).forEach(function (id) {
      if (id.indexOf('plans-') === 0) {
        values(docs[id].plans).forEach(function (p) { if (p.id && p.exp && p.date) plans.push(p); });
      } else if (id.indexOf('notes-') === 0) {
        var n = docs[id].notes || {};
        Object.keys(n).forEach(function (d) { if (typeof n[d] === 'string') notes[d] = n[d]; });
      }
    });
    plans.sort(function (a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; });
    return { cats: cats, exps: exps, plans: plans, notes: notes, prefs: (meta && meta.prefs) || {} };
  }

  // ---------- store ----------
  var store = (function () {
    var s = { mode: 'connecting', uid: null, db: null, server: {}, outbox: [], ready: false, live: false, error: null, flushing: false, retryIn: 0 };
    var subs = [], cache = null, timer = null;
    function emit() { cache = null; subs.forEach(function (f) { f(); }); }
    function docs() {
      if (!cache) {
        var d = s.server;
        s.outbox.forEach(function (it) { var o = {}; o[it.doc] = merge(d[it.doc] || {}, it.patch, false); d = Object.assign({}, d, o); });
        cache = d;
      }
      return cache;
    }
    function persist() {
      if (s.mode === 'local') LS.set('roadmap.local', { docs: s.server });
      else if (s.uid) {
        LS.set('roadmap.cloud.' + s.uid, { server: s.server, outbox: s.outbox.map(function (i) { return { doc: i.doc, patch: i.patch }; }) });
        LS.set('roadmap.cloud.last', s.uid);
      }
    }
    function patch(doc, p) {
      if (s.mode === 'local') {
        var o = {}; o[doc] = merge(s.server[doc] || {}, p, true);
        s.server = Object.assign({}, s.server, o);
        persist(); emit(); return;
      }
      // Coalesce into the newest queued write for this doc unless it is already on its way.
      var last = null;
      for (var i = s.outbox.length - 1; i >= 0; i--) if (s.outbox[i].doc === doc) { last = s.outbox[i]; break; }
      if (last && !last.inflight) last.patch = merge(last.patch, p, false);
      else s.outbox.push({ doc: doc, patch: p });
      persist(); emit(); schedule();
    }
    function schedule(delay) {
      if (timer || s.mode !== 'cloud') return;
      timer = setTimeout(function () { timer = null; flush(); }, delay == null ? 350 : delay);
    }
    function path(doc) { return 'data/users/' + s.uid + '/' + doc; }
    function fail(e) {
      var c = e && e.code;
      if (c === 'quota_exceeded') { s.error = 'Storage is full. Delete old steps to keep saving.'; return false; }
      if (c === 'invalid_argument' || c === 'transform_error') { s.error = 'One change could not be saved.'; return false; }
      return 'retry';
    }
    function write(it) {
      var ref = s.db.doc(path(it.doc));
      return ref.update(it.patch).then(function () { return true; }, function (e) {
        // update() needs the document to exist; create it the first time.
        if (e && e.code === 'invalid_argument' && !s.server[it.doc]) return ref.set(it.patch).then(function () { return true; }, fail);
        return fail(e);
      });
    }
    function flush() {
      if (s.flushing || s.mode !== 'cloud' || !s.outbox.length) return;
      s.flushing = true; emit();
      var step = function () {
        if (!s.outbox.length || s.mode !== 'cloud') { s.flushing = false; emit(); return; }
        var it = s.outbox[0];
        it.inflight = true;
        write(it).then(function (ok) {
          if (ok === 'retry') {
            it.inflight = false;
            s.retryIn = Math.min((s.retryIn || 1000) * 2, 30000);
            s.error = 'offline'; s.flushing = false; emit(); schedule(s.retryIn);
            return;
          }
          if (ok === true) {
            // Keep the saved change visible until the database's own snapshot arrives with it.
            var o = {}; o[it.doc] = merge(s.server[it.doc] || {}, it.patch, false);
            s.server = Object.assign({}, s.server, o);
          }
          s.outbox.shift(); s.retryIn = 0;
          if (ok === true && s.error === 'offline') s.error = null;
          persist(); step();
        });
      };
      step();
    }
    function subscribe() {
      if (s.unsub) s.unsub();
      s.unsub = s.db.collection('data/users/' + s.uid).onSnapshot(function (snap) {
        var server = {};
        snap.docs.forEach(function (d) { if (d.exists) server[d.id] = d.data(); });
        s.server = server;
        s.live = !snap.metadata.fromCache;
        if (s.live || Object.keys(server).length) s.ready = true;
        if (s.live && s.error === 'offline' && !s.outbox.length) s.error = null;
        persist(); emit();
        if (s.live && !server.meta && !s.outbox.some(function (i) { return i.doc === 'meta'; })) patch('meta', defaultMeta());
      }, function (err) {
        s.unsub = null; s.live = false; s.error = 'offline'; emit();
        if (err && err.code !== 'revoked') setTimeout(subscribe, 5000);
      });
    }
    function goLocal() {
      var local = LS.get('roadmap.local');
      s.mode = 'local'; s.uid = null; s.outbox = []; s.ready = true;
      s.server = (local && local.docs) || {};
      if (!s.server.meta) patch('meta', defaultMeta());
      emit();
    }
    function start() {
      var c = window.claude;
      if (!c || typeof c.use !== 'function') { goLocal(); return; }
      var last = LS.get('roadmap.cloud.last'), cached = last && LS.get('roadmap.cloud.' + last);
      if (cached) { s.uid = last; s.server = cached.server || {}; s.outbox = cached.outbox || []; s.ready = true; emit(); }
      Promise.all([c.use('db'), c.use('user')]).then(function (r) {
        var db = r[0], user = r[1];
        return (user ? user.id() : Promise.resolve(null)).then(function (id) {
          if (!db || !id) { goLocal(); return; }
          if (s.uid !== id) {
            var mine = LS.get('roadmap.cloud.' + id);
            s.server = (mine && mine.server) || {}; s.outbox = (mine && mine.outbox) || []; s.ready = !!mine;
          }
          s.uid = id; s.db = db; s.mode = 'cloud';
          emit(); subscribe(); schedule(0);
        });
      }).catch(goLocal);
    }
    function info() {
      var pending = s.outbox.length;
      if (s.mode === 'local') return { ready: s.ready, tone: 'warn', text: 'Saved in this browser only' };
      if (s.mode === 'connecting') return { ready: s.ready, tone: 'busy', text: 'Connecting to your account…' };
      if (s.error && s.error !== 'offline') return { ready: s.ready, tone: 'warn', text: s.error };
      if (s.error === 'offline') return { ready: s.ready, tone: 'warn', text: pending ? 'Offline · ' + pending + (pending === 1 ? ' change' : ' changes') + ' waiting to sync' : 'Offline · reconnecting' };
      if (pending || s.flushing) return { ready: s.ready, tone: 'busy', text: 'Saving…' };
      return { ready: s.ready, tone: s.live ? 'ok' : 'busy', text: s.live ? 'Saved to your account' : 'Syncing…' };
    }
    window.addEventListener('online', function () { schedule(0); });
    return { start: start, docs: docs, patch: patch, info: info, subscribe: function (f) { subs.push(f); } };
  })();

  // ---------- repeats ----------
  // A repeat rule makes one ordinary step per date, linked by a shared `series` id.
  var REPEAT_OPTIONS = [
    ['none', 'Doesn’t repeat'], ['1', 'Every day'], ['weekdays', 'Every weekday (Mon–Fri)'], ['2', 'Every 2 days'],
    ['3', 'Every 3 days'], ['7', 'Every week'], ['14', 'Every 2 weeks'], ['28', 'Every 4 weeks'], ['custom', 'Every N days…']
  ];
  var MAX_REPEATS = 366;
  function defaultRepeat(start) { return { mode: 'none', n: 5, until: U.shiftIso(start, 27) }; }
  // Dates after `start` (exclusive) up to `until` (inclusive).
  function repeatDates(start, r) {
    if (!r || r.mode === 'none' || !r.until || r.until <= start) return [];
    var step = r.mode === 'weekdays' ? 1 : r.mode === 'custom' ? Math.max(1, Math.min(365, parseInt(r.n, 10) || 1)) : +r.mode;
    var out = [], d = start;
    while (out.length < MAX_REPEATS) {
      d = U.shiftIso(d, step);
      if (d > r.until) break;
      if (r.mode === 'weekdays') { var wd = U.fromIso(d).getDay(); if (wd === 0 || wd === 6) continue; }
      out.push(d);
    }
    return out;
  }
  function RepeatFields(props) {
    var r = props.value;
    var set = function (patch) { props.onChange(Object.assign({}, r, patch)); };
    var n = repeatDates(props.start, r).length;
    return h('div', { className: 'rm-repeat' },
      h('select', { value: r.mode, 'aria-label': 'Repeat', onChange: function (e) { set({ mode: e.target.value }); } },
        REPEAT_OPTIONS.map(function (o) { return h('option', { key: o[0], value: o[0] }, o[1]); })),
      r.mode === 'custom' ? h('label', { className: 'rm-repeat-row' }, 'Every',
        h('input', { type: 'number', min: 1, max: 365, value: r.n, 'aria-label': 'Repeat every how many days', onChange: function (e) { set({ n: e.target.value }); } }), 'days') : null,
      r.mode !== 'none' ? h('label', { className: 'rm-repeat-row' }, 'Until',
        h('input', { type: 'date', value: r.until, min: U.shiftIso(props.start, 1), 'aria-label': 'Repeat until', onChange: function (e) { set({ until: e.target.value }); } })) : null,
      r.mode !== 'none' ? h('div', { className: 'rm-repeat-note' },
        n ? '+' + n + (n === 1 ? ' repeat' : ' repeats') + ' after ' + U.shortDate(props.start) : 'Pick an end date after ' + U.shortDate(props.start)) : null);
  }

  // ---------- daily note ----------
  // One day's steps grouped by category (legend order, "No category" last); within a category,
  // steps of the same experiment sit together. Returns the DailyNote sections and the copyable text.
  function dailyByCategory(date, dayPlans, exps, cats, catMap, notes) {
    var expOrder = {};
    exps.forEach(function (e, i) { expOrder[e.id] = i; });
    var em = {};
    exps.forEach(function (e) { em[e.id] = e; });
    var sections = cats.map(function (c) {
      var items = dayPlans.filter(function (p) { return (catMap[p.cat] ? p.cat : 'none') === c.id; });
      items.sort(function (a, b) { return ((expOrder[a.exp] || 0) - (expOrder[b.exp] || 0)) || (a.id < b.id ? -1 : 1); });
      return { id: c.id, title: c.name, items: items };
    }).filter(function (sec) { return sec.items.length; });
    var lines = [U.longDate(date)];
    sections.forEach(function (sec) {
      lines.push('', sec.title.toUpperCase());
      sec.items.forEach(function (p) {
        var e = em[p.exp] || {};
        lines.push((p.done ? '[x] ' : '[ ] ') + p.text + (e.desk || !e.name ? '' : ' — ' + e.name));
      });
    });
    var note = ((notes || {})[date] || '').trim();
    if (note) lines.push('', 'NOTES', note);
    return { sections: sections, done: dayPlans.filter(function (p) { return p.done; }).length, total: dayPlans.length, text: lines.join('\n') };
  }

  // ---------- small pieces ----------
  // Inline editor for one step: text, category, repeat, delete. Replaces the step row while open.
  // `later` = how many later steps of the same repeat series exist; the checkbox applies edits and deletes to them too.
  function StepEditor(props) {
    var p = props.plan;
    // The draft lives in a ref so Save/Delete always see the latest values, plus state to re-render.
    var ref = R.useRef(null);
    if (!ref.current) ref.current = { text: p.text, cat: p.cat || 'none', repeat: defaultRepeat(p.date), later: false };
    var force = R.useState(0)[1];
    var set = function (patch) { ref.current = Object.assign({}, ref.current, patch); props.onDraft(ref.current); force(function (n) { return n + 1; }); };
    var d = ref.current;
    var save = function () { props.onSave(ref.current); };
    return h('div', { className: 'rm-addform rm-editform', onPointerDown: stop, onDoubleClick: stop },
      h('input', {
        autoFocus: true, value: d.text, 'aria-label': 'Step text',
        onChange: function (e) { set({ text: e.target.value }); },
        onKeyDown: function (e) { if (e.key === 'Enter') { e.preventDefault(); save(); } else if (e.key === 'Escape') props.onCancel(); }
      }),
      h('select', { value: d.cat, 'aria-label': 'Category', onChange: function (e) { set({ cat: e.target.value }); } }, props.options),
      h(RepeatFields, { start: p.date, value: d.repeat, onChange: function (v) { set({ repeat: v }); } }),
      props.later ? h('label', { className: 'rm-repeat-row rm-later' },
        h('input', { type: 'checkbox', checked: d.later, onChange: function (e) { set({ later: e.target.checked }); } }),
        'Also change the ' + props.later + ' later ' + (props.later === 1 ? 'repeat' : 'repeats')) : null,
      h('div', { className: 'rm-addform-actions' },
        h('button', { type: 'button', onClick: function () { props.onDelete(ref.current.later); } }, 'Delete'),
        h('button', { type: 'button', onClick: props.onCancel }, 'Cancel'),
        h('button', { type: 'button', className: 'is-go', onClick: save }, 'Save')));
  }

  function Seg(props) {
    return h('div', { className: 'rm-seg', role: 'radiogroup', 'aria-label': props.label },
      props.options.map(function (o) {
        var on = o.value === props.value;
        return h('button', { key: o.value, type: 'button', role: 'radio', 'aria-checked': on ? 'true' : 'false', className: on ? 'is-on' : '', onClick: function () { props.onChange(o.value); } }, o.label);
      }));
  }

  // Running vs completed rows. Like Roadmap.utils.sortExperiments, except a pinned experiment
  // stays with the running ones (in its saved order) even when all its steps are done.
  function splitExperiments(exps, plans) {
    var sorted = U.sortExperiments(exps, plans);
    var pinnedDone = sorted.completed.filter(function (e) { return e.pinned; });
    if (!pinnedDone.length) return sorted;
    var keep = {};
    sorted.active.concat(pinnedDone).forEach(function (e) { keep[e.id] = 1; });
    return {
      active: exps.filter(function (e) { return keep[e.id]; }),
      completed: sorted.completed.filter(function (e) { return !e.pinned; })
    };
  }
  // Pin glyph, drawn like Roadmap.Icon: 24px grid, 2px round stroke, currentColor.
  function PinIcon(props) {
    return h('svg', { className: 'rm-icon', width: props.size || 13, height: props.size || 13, viewBox: '0 0 24 24', fill: props.filled ? 'currentColor' : 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
      h('path', { d: 'M9 3h6l-1 6 4 4H6l4-4-1-6z' }), h('path', { d: 'M12 13v8', fill: 'none' }));
  }

  // ---------- month & year views ----------
  // Calendar-style views of the same data, after Apple Calendar: a month grid with multi-day experiment bars
  // and step "events", a year of mini months as a workload heat map, and a click-for-details preview.
  var VIEWS = [{ value: 'week', label: 'Timeline' }, { value: 'month', label: 'Month' }, { value: 'year', label: 'Year' }];
  var DOW_MON = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  var MONTH_WEEK_COL = 40;   // px, ISO week number column
  var MONTH_LANES = 4;       // experiment bars shown per week
  var LANE_H = 19;
  function firstOfMonth(iso) { return iso.slice(0, 8) + '01'; }
  function addMonths(iso, n) { var d = U.fromIso(iso); return U.iso(new Date(d.getFullYear(), d.getMonth() + n, 1)); }
  function isWeekend(iso) { var w = U.fromIso(iso).getDay(); return w === 0 || w === 6; }
  function tint(color, pct) { return 'color-mix(in srgb, ' + color + ' ' + pct + '%, var(--bg-surface))'; }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }
  function fullDate(iso) {
    var d = U.fromIso(iso);
    return ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][d.getDay()] + ', ' + MON[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear();
  }
  function spanLabel(a, b) {
    var x = U.fromIso(a), y = U.fromIso(b);
    if (a === b) return MON[x.getMonth()] + ' ' + x.getDate() + ', ' + x.getFullYear();
    return MON[x.getMonth()] + ' ' + x.getDate() + (x.getFullYear() !== y.getFullYear() ? ', ' + x.getFullYear() : '') + ' – ' + MON[y.getMonth()] + ' ' + y.getDate() + ', ' + y.getFullYear();
  }
  // Status of a step relative to today, as a short label and a tone for its chip.
  function stepStatus(p, today) {
    if (p.done) return { text: 'Done', tone: 'done' };
    var n = U.dayDiff(today, p.date);
    if (n === 0) return { text: 'Today', tone: 'now' };
    if (n > 0) return { text: n === 1 ? 'Tomorrow' : 'In ' + n + ' days', tone: 'future' };
    return { text: 'Overdue · ' + plural(-n, 'day'), tone: 'late' };
  }
  // Per-experiment facts used by the month bars, the Gantt and the previews.
  function experimentStats(exps, byExp, today) {
    var out = {};
    exps.forEach(function (e) {
      var ps = (byExp[e.id] || []).slice().sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : (a.id < b.id ? -1 : 1); });
      var done = ps.filter(function (p) { return p.done; }).length;
      var next = ps.find(function (p) { return !p.done && p.date >= today; }) || null;
      var overdue = ps.filter(function (p) { return !p.done && p.date < today; }).length;
      out[e.id] = {
        plans: ps, first: ps.length ? ps[0].date : null, last: ps.length ? ps[ps.length - 1].date : null,
        total: ps.length, done: done, next: next, overdue: overdue, complete: !e.desk && ps.length > 0 && done === ps.length
      };
    });
    return out;
  }

  function renderMonth(self, c) {
    var s = self.state, anchor = s.monthAnchor || firstOfMonth(c.today), month = U.fromIso(anchor).getMonth();
    var gridStart = U.mondayOf(anchor), weeks = [];
    for (var w = 0; w < 6; w++) {
      var ws = U.shiftIso(gridStart, w * 7);
      if (w >= 4 && ws > anchor && U.fromIso(ws).getMonth() !== month) break;
      weeks.push(ws);
    }
    var bars = c.exps.filter(function (e) { return !e.desk && c.stats[e.id].total; });
    var pill = function (p) {
      var cat = c.catMap[p.cat] || NO_CAT, ex = c.expMap[p.exp] || { name: '', color: 'var(--exp-desk)' };
      var late = !p.done && p.date < c.today;
      return h('button', {
        key: p.id, type: 'button',
        className: 'rm-mpill' + (p.done ? ' is-done' : '') + (c.selSet[p.id] ? ' is-selected' : '') + (s.catFilter && s.catFilter !== p.cat ? ' is-dimmed' : '') + (late ? ' is-late' : ''),
        title: p.text + (ex.name ? ' · ' + ex.name : '') + ' · ' + cat.name + (late ? ' · overdue' : ''),
        onPointerDown: function (e) { self.chipDown(p, e); },
        onClick: function (e) {
          e.stopPropagation();
          if (self.justDragged || e.shiftKey || e.metaKey || e.ctrlKey) return;
          self.openPreview('step', p.id, e.currentTarget);
        }
      },
        h('i', { className: 'rm-mpill-dot', style: { background: ex.color } }),
        h('span', { className: 'rm-tag', style: { color: p.done ? 'var(--done-ink)' : cat.color } }, cat.tag),
        late ? h('span', { className: 'rm-mpill-late', 'aria-label': 'overdue' }, '!') : null,
        h('span', { className: 'rm-mpill-text' }, p.text));
    };
    var rows = weeks.map(function (ws) {
      var we = U.shiftIso(ws, 6), lanes = [], segs = [], hidden = 0;
      bars.filter(function (e) { var st = c.stats[e.id]; return st.first <= we && st.last >= ws; })
        .sort(function (a, b) { return c.stats[a.id].first < c.stats[b.id].first ? -1 : c.stats[a.id].first > c.stats[b.id].first ? 1 : 0; })
        .forEach(function (e) {
          var st = c.stats[e.id];
          var a = Math.max(0, U.dayDiff(ws, st.first)), b = Math.min(6, U.dayDiff(ws, st.last));
          var lane = lanes.findIndex(function (end) { return end < a; });
          if (lane < 0) { lane = lanes.length; lanes.push(-1); }
          lanes[lane] = b;
          if (lane >= MONTH_LANES) { hidden++; return; }
          segs.push({ e: e, a: a, b: b, lane: lane });
        });
      var used = Math.min(lanes.length, MONTH_LANES);
      var cells = [];
      for (var i = 0; i < 7; i++) {
        (function (d) {
          var ps = (c.byDate[d] || []).slice().sort(function (x, y) { return ((c.expOrder[x.exp] || 0) - (c.expOrder[y.exp] || 0)) || (x.id < y.id ? -1 : 1); });
          var show = Math.max(2, 5 - used), more = ps.length > show + 1 ? ps.length - show : 0;
          if (!more) show = ps.length;
          var inMonth = U.fromIso(d).getMonth() === month, dd = U.fromIso(d).getDate();
          var cls = 'rm-mday' + (inMonth ? '' : ' is-out') + (isWeekend(d) ? ' is-weekend' : '') + (d === c.today ? ' is-today' : '') +
            (c.dayDone(d) ? ' is-day-done' : '') + (c.dropDates[d] ? ' is-drop' : '') +
            (s.exportMode ? (s.exportDays.indexOf(d) >= 0 ? ' is-export' : '') : (d === s.focus ? ' is-focused' : ''));
          cells.push(h('div', {
            key: d, className: cls, role: 'gridcell', 'aria-label': fullDate(d) + ', ' + plural(ps.length, 'step'),
            onClick: function () { self.monthDayClick(d); },
            onPointerEnter: function () { self.enter(d); self.hoverCell = { exp: null, date: d }; }
          },
            h('div', { className: 'rm-mday-head' },
              h('span', { className: 'rm-mday-num' }, dd === 1 ? MON[U.fromIso(d).getMonth()] + ' 1' : dd)),
            h('div', { style: { height: used * LANE_H } }),
            ps.slice(0, show).map(pill),
            more > 0 ? h('button', { type: 'button', className: 'rm-mmore', onClick: function (e) { e.stopPropagation(); self.setState({ focus: d }); } }, plural(more, 'more step')) : null));
        })(U.shiftIso(ws, i));
      }
      return h('div', { key: ws, className: 'rm-mweek' },
        h('div', { className: 'rm-mwk' }, h('span', { className: 'rm-tag' }, 'W' + U.isoWeek(U.fromIso(ws))), hidden ? h('span', { className: 'rm-mwk-more', title: plural(hidden, 'more experiment') }, '+' + hidden) : null),
        cells,
        segs.map(function (g) {
          var e = g.e, st = c.stats[e.id], segStart = U.shiftIso(ws, g.a);
          var startsHere = st.first === segStart, endsHere = st.last === U.shiftIso(ws, g.b);
          return h('button', {
            key: e.id, type: 'button',
            className: 'rm-mspan' + (startsHere ? ' is-start' : '') + (endsHere ? ' is-end' : '') + (st.complete ? ' is-complete' : ''),
            style: {
              top: 30 + g.lane * LANE_H,
              left: 'calc(' + MONTH_WEEK_COL + 'px + (100% - ' + MONTH_WEEK_COL + 'px) * ' + g.a + ' / 7 + 3px)',
              width: 'calc((100% - ' + MONTH_WEEK_COL + 'px) * ' + (g.b - g.a + 1) + ' / 7 - 6px)',
              background: st.complete ? undefined : tint(e.color, 34)
            },
            title: e.name + ' · ' + spanLabel(st.first, st.last) + ' · ' + st.done + ' of ' + st.total + ' steps done',
            onPointerDown: stop,
            onClick: function (ev) { ev.stopPropagation(); self.openPreview('exp', e.id, ev.currentTarget); }
          },
            h('span', { className: 'rm-mspan-name' }, e.name),
            h('span', { className: 'rm-mspan-d' }, 'D' + U.dayDiff(st.first, segStart)));
        }));
    });
    return h('section', { className: 'rm-cal rm-month' + (s.drag ? ' is-dragging' : ''), 'aria-label': 'Month view', onPointerLeave: function () { self.hoverCell = null; } },
      h('div', { className: 'rm-cal-head' },
        h('h2', { className: 'rm-cal-title' }, h('b', null, MONL[month]), ' ', U.fromIso(anchor).getFullYear()),
        h('span', { className: 'rm-cal-note' }, 'Bars span each experiment from its first to last step · D = day of the protocol')),
      h('div', { className: 'rm-mdow' }, h('span', null), DOW_MON.map(function (d) { return h('span', { key: d }, d); })),
      rows);
  }

  // GitHub-style contribution map: one square per day, weeks as columns, Monday to Sunday as rows.
  var CONTRIB_MODES = [{ value: 'done', label: 'Completed' }, { value: 'planned', label: 'Planned' }, { value: 'exp', label: 'By experiment' }];
  var CONTRIB_MIX = [0, 34, 56, 78, 100];      // % of the accent mixed into the surface, per level
  var CONTRIB_EXP_MIX = [0, 45, 65, 82, 100]; // % of the experiment color, per level
  var WEEKDAY_NAMES = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];
  function contribLevel(n) { return !n ? 0 : n === 1 ? 1 : n <= 3 ? 2 : n <= 5 ? 3 : 4; }
  function renderContrib(self, c, y, inYear) {
    var s = self.state, mode = s.contrib || s.data.prefs.contrib || 'done';
    var y0 = y + '-01-01', y1 = y + '-12-31';
    var planned = {}, done = {}, perExp = {};
    inYear.forEach(function (p) {
      planned[p.date] = (planned[p.date] || 0) + 1;
      if (p.done) done[p.date] = (done[p.date] || 0) + 1;
      var m = perExp[p.date] = perExp[p.date] || {};
      m[p.exp] = (m[p.exp] || 0) + 1;
    });
    var value = function (d) { return (mode === 'done' ? done[d] : planned[d]) || 0; };
    // The experiment that owns a day: most steps that day, bench experiments before the desk row.
    var owner = function (d) {
      var m = perExp[d];
      if (!m) return null;
      return Object.keys(m).sort(function (a, b) {
        return ((c.expMap[a] && c.expMap[a].desk ? 1 : 0) - (c.expMap[b] && c.expMap[b].desk ? 1 : 0)) || (m[b] - m[a]) || ((c.expOrder[a] || 0) - (c.expOrder[b] || 0));
      })[0];
    };
    var expList = function (d) {
      var m = perExp[d] || {};
      return Object.keys(m).map(function (id) { return ((c.expMap[id] || {}).name || 'Unknown') + ' (' + m[id] + ')'; }).join(', ');
    };
    // Streaks count consecutive days with at least one completed step.
    var longest = 0, run = 0, totalDone = 0, byWeekday = [0, 0, 0, 0, 0, 0, 0];
    for (var d = y0; d <= y1; d = U.shiftIso(d, 1)) {
      if (done[d]) { run++; longest = Math.max(longest, run); totalDone += done[d]; byWeekday[U.fromIso(d).getDay()] += done[d]; } else run = 0;
    }
    var current = 0;
    if (c.today >= y0) {
      var cur = c.today > y1 ? y1 : c.today;
      if (!done[cur]) cur = U.shiftIso(cur, -1); // like GitHub, today does not break a streak yet
      while (cur >= y0 && done[cur]) { current++; cur = U.shiftIso(cur, -1); }
    }
    var topDay = byWeekday.indexOf(Math.max.apply(null, byWeekday));
    var totalPlanned = inYear.length, labDays = Object.keys(planned).length;
    var expsSeen = {};
    inYear.forEach(function (p) { if (c.expMap[p.exp] && !c.expMap[p.exp].desk) expsSeen[p.exp] = 1; });
    var nExps = Object.keys(expsSeen).length;
    var start = U.mondayOf(y0), nWeeks = Math.ceil((U.dayDiff(start, y1) + 1) / 7);
    var cells = [], months = [], lastM = -1, owners = {};
    for (var w = 0; w < nWeeks; w++) {
      var first = U.shiftIso(start, w * 7);
      var mm = U.fromIso(first < y0 ? y0 : first).getMonth();
      if (mm !== lastM) { months.push(h('span', { key: w, style: { gridColumn: (w + 1) + ' / span 4' } }, MON[mm])); lastM = mm; }
      for (var r = 0; r < 7; r++) {
        (function (d) {
          if (d < y0 || d > y1) { cells.push(h('span', { key: d, className: 'rm-gh-cell is-out' })); return; }
          var n = value(d), lv = contribLevel(n), bg, title;
          if (mode === 'exp') {
            var o = owner(d), ex = o && c.expMap[o];
            if (o) owners[o] = (owners[o] || 0) + 1;
            lv = contribLevel(planned[d] || 0);
            bg = ex ? tint(ex.color, CONTRIB_EXP_MIX[lv]) : null;
            title = planned[d] ? expList(d) + ' on ' + fullDate(d) : 'No steps on ' + fullDate(d);
          } else {
            bg = lv ? tint('var(--accent)', CONTRIB_MIX[lv]) : null;
            title = mode === 'done'
              ? (n ? plural(n, 'step') + ' completed' : 'No steps completed') + ' on ' + fullDate(d)
              : (n ? plural(n, 'step') + ' planned (' + (done[d] || 0) + ' done)' : 'Nothing planned') + ' on ' + fullDate(d);
            if (n) title += ' · ' + expList(d);
          }
          cells.push(h('button', {
            key: d, type: 'button', className: 'rm-gh-cell' + (d === c.today ? ' is-today' : '') + (d === s.focus ? ' is-focused' : ''),
            style: bg ? { background: bg } : undefined, title: title, 'aria-label': title,
            onClick: function () { self.goMonth(d); }
          }));
        })(U.shiftIso(first, r));
      }
    }
    var legend = mode === 'exp'
      ? Object.keys(owners).sort(function (a, b) { return owners[b] - owners[a]; }).slice(0, 8).map(function (id) {
        var ex = c.expMap[id] || { name: 'Unknown', color: 'var(--exp-desk)' };
        return h('span', { key: id, className: 'rm-gh-key', title: plural(owners[id], 'day') }, h('i', { style: { background: ex.color } }), ex.name);
      })
      : [h('span', { key: 'l' }, 'Less')].concat(CONTRIB_MIX.map(function (pct, i) {
        return h('i', { key: i, className: 'rm-gh-cell is-key', style: i ? { background: tint('var(--accent)', pct) } : undefined });
      }), h('span', { key: 'm' }, 'More'));
    var headline = mode === 'done' ? [h('b', { key: 'n' }, totalDone), ' ' + (totalDone === 1 ? 'step' : 'steps') + ' completed in ' + y]
      : mode === 'planned' ? [h('b', { key: 'n' }, totalPlanned), ' ' + (totalPlanned === 1 ? 'step' : 'steps') + ' planned in ' + y]
      : [h('b', { key: 'n' }, nExps), ' ' + (nExps === 1 ? 'experiment' : 'experiments') + ' across ', h('b', { key: 'd' }, labDays), ' lab days in ' + y];
    return h('div', { className: 'rm-gh' },
      h('div', { className: 'rm-gh-head' },
        h('h3', null, headline),
        h('div', { className: 'rm-views rm-views-sm', role: 'radiogroup', 'aria-label': 'Contribution map shows' }, CONTRIB_MODES.map(function (o) {
          var on = o.value === mode;
          return h('button', { key: o.value, type: 'button', role: 'radio', 'aria-checked': on ? 'true' : 'false', className: on ? 'is-on' : '', onClick: function () { self.setState({ contrib: o.value }); self.savePrefs({ contrib: o.value }); } }, o.label);
        }))),
      h('div', { className: 'rm-gh-scroll' },
        h('div', { className: 'rm-gh-board', style: { '--gh-weeks': nWeeks } },
          h('div', { className: 'rm-gh-months' }, months),
          h('div', { className: 'rm-gh-days' }, ['Mon', '', 'Wed', '', 'Fri', '', ''].map(function (t, i) { return h('span', { key: i }, t); })),
          h('div', { className: 'rm-gh-grid' }, cells))),
      h('div', { className: 'rm-gh-foot' },
        h('div', { className: 'rm-gh-streaks' },
          h('span', null, 'Longest streak ', h('b', null, plural(longest, 'day'))),
          h('span', null, 'Current streak ', h('b', null, plural(current, 'day'))),
          totalDone ? h('span', null, 'Most done on ', h('b', null, WEEKDAY_NAMES[topDay])) : null),
        h('div', { className: 'rm-gh-legend' }, legend)));
  }

  function renderYear(self, c) {
    var s = self.state, y = s.yearAnchor || U.fromIso(c.today).getFullYear();
    var y0 = y + '-01-01', y1 = y + '-12-31', diy = U.dayDiff(y0, (y + 1) + '-01-01');
    var inYear = c.plans.filter(function (p) { return p.date >= y0 && p.date <= y1; });
    var perDay = {}, lateDay = {}, benchWeekend = {};
    inYear.forEach(function (p) {
      perDay[p.date] = (perDay[p.date] || 0) + 1;
      if (!p.done && p.date < c.today) lateDay[p.date] = 1;
      var cat = c.catMap[p.cat] || NO_CAT;
      if ((cat.group || 'bench') === 'bench' && isWeekend(p.date)) benchWeekend[p.date] = 1;
    });
    var done = inYear.filter(function (p) { return p.done; }).length;
    var late = inYear.filter(function (p) { return !p.done && p.date < c.today; }).length;
    var busiest = Object.keys(perDay).sort(function (a, b) { return (perDay[b] - perDay[a]) || (a < b ? -1 : 1); })[0];
    var runs = c.exps.filter(function (e) { var st = c.stats[e.id]; return !e.desk && st.total && st.first <= y1 && st.last >= y0; })
      .sort(function (a, b) { return c.stats[a.id].first < c.stats[b.id].first ? -1 : 1; });
    var longest = runs.slice().sort(function (a, b) { return U.dayDiff(c.stats[b.id].first, c.stats[b.id].last) - U.dayDiff(c.stats[a.id].first, c.stats[a.id].last); })[0];
    var nDoneRuns = runs.filter(function (e) { return c.stats[e.id].complete; }).length;
    var stat = function (label, value, sub, tone) {
      return h('div', { key: label, className: 'rm-ystat' + (tone ? ' is-' + tone : '') },
        h('span', { className: 'rm-ystat-label' }, label), h('b', null, value), sub ? h('span', { className: 'rm-ystat-sub' }, sub) : null);
    };
    var level = function (n) { return !n ? 0 : n === 1 ? 1 : n <= 3 ? 2 : n <= 5 ? 3 : 4; };
    var HEAT = [null, 16, 32, 52, 74];
    var minis = [];
    for (var m = 0; m < 12; m++) {
      (function (m) {
        var first = U.iso(new Date(y, m, 1)), start = U.mondayOf(first), cells = [];
        for (var i = 0; i < 42; i++) {
          var d = U.shiftIso(start, i);
          if (i % 7 === 0 && i >= 28 && U.fromIso(d).getMonth() !== m) break;
          if (U.fromIso(d).getMonth() !== m) { cells.push(h('span', { key: d, className: 'rm-yday is-out' })); continue; }
          (function (d) {
            var n = perDay[d] || 0, lv = level(n);
            cells.push(h('button', {
              key: d, type: 'button',
              className: 'rm-yday' + (lv >= 3 ? ' is-hot' : '') + (isWeekend(d) ? ' is-weekend' : '') + (d === c.today ? ' is-today' : '') + (d === s.focus ? ' is-focused' : ''),
              style: lv ? { background: tint('var(--accent)', HEAT[lv]) } : undefined,
              title: fullDate(d) + (n ? ' · ' + plural(n, 'step') : '') + (lateDay[d] ? ' · overdue' : '') + (benchWeekend[d] ? ' · weekend bench work' : ''),
              onClick: function () { self.goMonth(d); }
            }, U.fromIso(d).getDate(), lateDay[d] ? h('i', { className: 'rm-yday-late', 'aria-hidden': 'true' }) : null));
          })(d);
        }
        var nMonth = inYear.filter(function (p) { return p.date.slice(5, 7) === first.slice(5, 7); }).length;
        var isNow = c.today.slice(0, 7) === first.slice(0, 7);
        minis.push(h('div', { key: m, className: 'rm-mini' },
          h('button', { type: 'button', className: 'rm-mini-title' + (isNow ? ' is-now' : ''), onClick: function () { self.goMonth(first); } },
            MONL[m], h('span', null, nMonth ? plural(nMonth, 'step') : '')),
          h('div', { className: 'rm-mini-grid' }, DOW_MON.map(function (d) { return h('span', { key: d, className: 'rm-mini-dow' }, d[0]); }), cells)));
      })(m);
    }
    var pct = function (iso) { return Math.max(0, Math.min(100, 100 * U.dayDiff(y0, iso) / diy)); };
    var todayPct = c.today >= y0 && c.today <= y1 ? pct(c.today) + 100 / diy / 2 : null;
    var gantt = h('div', { className: 'rm-gantt' },
      h('div', { className: 'rm-gantt-head' },
        h('h3', null, 'Experiment progress'),
        h('span', { className: 'rm-cal-note' }, 'Each bar runs from an experiment’s first to last step; ticks are steps (filled = done, ring = open, orange = overdue)')),
      runs.length ? h('div', { className: 'rm-gantt-body' },
        h('div', { className: 'rm-gantt-row rm-gantt-months' }, h('span', null),
          h('div', { className: 'rm-gantt-track' }, MONL.map(function (n, i) {
            return h('span', { key: n, style: { left: pct(U.iso(new Date(y, i, 1))) + '%' } }, n.slice(0, 3));
          }))),
        runs.map(function (e) {
          var st = c.stats[e.id];
          var a = st.first < y0 ? y0 : st.first, b = st.last > y1 ? y1 : st.last;
          var left = pct(a), width = Math.max(0.6, pct(U.shiftIso(b, 1)) - left);
          return h('div', { key: e.id, className: 'rm-gantt-row' + (st.complete ? ' is-complete' : '') },
            h('button', { type: 'button', className: 'rm-gantt-name', onClick: function (ev) { self.openPreview('exp', e.id, ev.currentTarget); } },
              h('i', { style: { background: e.color } }), h('span', null, e.name)),
            h('div', { className: 'rm-gantt-track' },
              MONL.map(function (n, i) { return h('i', { key: n, className: 'rm-gantt-grid', style: { left: pct(U.iso(new Date(y, i, 1))) + '%' } }); }),
              h('button', {
                type: 'button', className: 'rm-gantt-bar', title: e.name + ' · ' + spanLabel(st.first, st.last),
                style: { left: left + '%', width: width + '%', background: tint(e.color, st.complete ? 18 : 38), borderColor: e.color },
                onClick: function (ev) { self.openPreview('exp', e.id, ev.currentTarget); }
              }),
              st.plans.filter(function (p) { return p.date >= y0 && p.date <= y1; }).map(function (p) {
                var lt = !p.done && p.date < c.today;
                return h('i', { key: p.id, className: 'rm-gantt-tick' + (p.done ? ' is-done' : lt ? ' is-late' : ''), style: { left: 'calc(' + (pct(p.date) + 50 / diy) + '% - 3px)' }, title: U.shortDate(p.date) + ' · ' + p.text });
              }),
              todayPct != null ? h('i', { className: 'rm-gantt-today', style: { left: todayPct + '%' } }) : null),
            h('span', { className: 'rm-gantt-pct' }, st.done + '/' + st.total));
        })) : h('div', { className: 'rm-note-empty' }, 'No experiments have steps in ' + y + '.'));
    return h('section', { className: 'rm-cal rm-year', 'aria-label': 'Year view' },
      h('div', { className: 'rm-cal-head' }, h('h2', { className: 'rm-cal-title' }, h('b', null, y)),
        h('span', { className: 'rm-cal-note' }, 'Shading = steps per day · orange dot = overdue')),
      h('div', { className: 'rm-ystats' },
        stat('Steps planned', inYear.length, inYear.length ? Math.round(100 * done / inYear.length) + '% done' : null),
        stat('Experiments', runs.length, runs.length ? nDoneRuns + ' completed' : null),
        stat('Overdue steps', late, late ? 'before today, not ticked' : 'nothing behind', late ? 'late' : null),
        stat('Weekend bench days', Object.keys(benchWeekend).length, 'feeds, splits, harvests…'),
        stat('Busiest day', busiest ? U.shortDate(busiest) : '—', busiest ? plural(perDay[busiest], 'step') : null),
        stat('Longest run', longest ? (U.dayDiff(c.stats[longest.id].first, c.stats[longest.id].last) + 1) + ' days' : '—', longest ? longest.name : null)),
      renderContrib(self, c, y, inYear),
      h('div', { className: 'rm-ygrid' }, minis),
      gantt);
  }

  // Apple-style popover with the details of one step or one experiment.
  function renderPreview(self, c) {
    var pv = self.state.preview;
    if (!pv) return null;
    var body;
    if (pv.kind === 'step') {
      var p = c.plans.find(function (x) { return x.id === pv.id; });
      if (!p) return null;
      var ex = c.expMap[p.exp] || { name: '', color: 'var(--exp-desk)' }, cat = c.catMap[p.cat] || NO_CAT;
      var st = c.stats[p.exp] || { plans: [] }, status = stepStatus(p, c.today);
      var idx = st.plans.indexOf(st.plans.find(function (x) { return x.id === p.id; }));
      var prev = idx > 0 ? st.plans[idx - 1] : null, next = idx >= 0 && idx < st.plans.length - 1 ? st.plans[idx + 1] : null;
      var series = p.series ? c.plans.filter(function (x) { return x.series === p.series; }).sort(function (a, b) { return a.date < b.date ? -1 : 1; }) : null;
      var span = st.first ? U.dayDiff(st.first, st.last) + 1 : 0;
      body = [
        h('div', { key: 'x', className: 'rm-pop-exp' }, h('i', { style: { background: ex.color } }), ex.name || 'No experiment'),
        h('h3', { key: 't', className: 'rm-pop-title' + (p.done ? ' is-done' : '') }, p.text),
        h('div', { key: 'c', className: 'rm-pop-row' }, h('span', { className: 'rm-tag', style: { color: cat.color } }, cat.tag), cat.name),
        h('div', { key: 'd', className: 'rm-pop-row' }, fullDate(p.date), h('span', { className: 'rm-pop-chip is-' + status.tone }, status.text)),
        !ex.desk && st.first ? h('div', { key: 'p', className: 'rm-pop-row rm-pop-muted' },
          h('b', { className: 'rm-tag' }, 'D' + U.dayDiff(st.first, p.date)), 'Day ' + (U.dayDiff(st.first, p.date) + 1) + ' of ' + span + ' in this experiment') : null,
        series ? h('div', { key: 's', className: 'rm-pop-row rm-pop-muted' }, 'Repeat ' + (series.indexOf(series.find(function (x) { return x.id === p.id; })) + 1) + ' of ' + series.length +
          ' · ' + series.filter(function (x) { return x.done; }).length + ' done') : null,
        (prev || next) ? h('div', { key: 'n', className: 'rm-pop-flow' },
          h('div', { className: 'rm-eyebrow' }, 'Protocol flow'),
          prev ? h('div', { className: 'rm-pop-step' + (prev.done ? ' is-done' : '') }, h('span', { className: 'rm-pop-when' }, U.shortDate(prev.date)), prev.text) : null,
          h('div', { className: 'rm-pop-step is-current' }, h('span', { className: 'rm-pop-when' }, U.shortDate(p.date)), p.text),
          next ? h('div', { className: 'rm-pop-step' + (next.done ? ' is-done' : '') }, h('span', { className: 'rm-pop-when' }, U.shortDate(next.date)), next.text) : null) : null,
        h('div', { key: 'a', className: 'rm-pop-actions' },
          h(RM.Button, { size: 'sm', variant: p.done ? 'default' : 'primary', icon: 'check', onClick: function () { self.toggle(p.id); } }, p.done ? 'Mark not done' : 'Mark done'),
          h(RM.Button, { size: 'sm', onClick: function () { self.showInTimeline(p.date); } }, 'Show in timeline'),
          h(RM.Button, { size: 'sm', onClick: function () { self.setState({ preview: null }); self.deleteStep(p, false); } }, 'Delete'))
      ];
    } else {
      var e = c.expMap[pv.id];
      if (!e) return null;
      var es = c.stats[e.id];
      var cats = {};
      es.plans.forEach(function (x) { cats[x.cat] = (cats[x.cat] || 0) + 1; });
      var dayN = es.first && c.today >= es.first && c.today <= es.last ? U.dayDiff(es.first, c.today) + 1 : null;
      body = [
        h('div', { key: 'x', className: 'rm-pop-exp' }, h('i', { style: { background: e.color } }), (es.complete ? 'Completed experiment' : 'Experiment') + (e.pinned ? ' · pinned' : '')),
        h('h3', { key: 't', className: 'rm-pop-title' }, e.name),
        es.first ? h('div', { key: 'd', className: 'rm-pop-row' }, spanLabel(es.first, es.last),
          h('span', { className: 'rm-pop-chip' }, plural(U.dayDiff(es.first, es.last) + 1, 'day'))) : null,
        dayN ? h('div', { key: 'n', className: 'rm-pop-row rm-pop-muted' }, h('b', { className: 'rm-tag' }, 'D' + (dayN - 1)), 'Today is day ' + dayN + ' of the run') : null,
        h('div', { key: 'p', className: 'rm-pop-progress' }, h(RM.ProgressBar, { done: es.done, total: es.total })),
        es.next ? h('div', { key: 'nx', className: 'rm-pop-row' }, h('span', { className: 'rm-pop-label' }, 'Next'), es.next.text + ' · ' + U.shortDate(es.next.date)) : null,
        es.overdue ? h('div', { key: 'o', className: 'rm-pop-row' }, h('span', { className: 'rm-pop-chip is-late' }, plural(es.overdue, 'overdue step'))) : null,
        Object.keys(cats).length ? h('div', { key: 'c', className: 'rm-pop-cats' }, Object.keys(cats).map(function (k) {
          var ct = c.catMap[k] || NO_CAT;
          return h('span', { key: k, title: ct.name }, h('span', { className: 'rm-tag', style: { color: ct.color } }, ct.tag), ' ' + cats[k]);
        })) : null,
        h('div', { key: 'a', className: 'rm-pop-actions' },
          es.first ? h(RM.Button, { size: 'sm', variant: 'primary', onClick: function () { self.showInTimeline(es.next ? es.next.date : es.first); } }, 'Show in timeline') : null,
          es.first ? h(RM.Button, { size: 'sm', onClick: function () { self.goMonth(es.next ? es.next.date : es.first); } }, 'Open month') : null,
          e.desk ? null : h(RM.Button, { size: 'sm', 'aria-pressed': e.pinned ? 'true' : 'false', onClick: function () { self.togglePin(e); } }, h(PinIcon, { size: 13, filled: !!e.pinned }), e.pinned ? 'Unpin' : 'Pin'))
      ];
    }
    return h('div', {
      className: 'rm-pop is-' + pv.side, role: 'dialog', 'aria-label': pv.kind === 'step' ? 'Step details' : 'Experiment details',
      style: { left: pv.left, top: pv.top }
    },
      h('i', { className: 'rm-pop-arrow', style: pv.side === 'below' ? { left: pv.arrow } : { top: pv.arrow } }),
      h('button', { type: 'button', className: 'rm-pop-close', 'aria-label': 'Close', onClick: function () { self.setState({ preview: null }); } }, h(RM.Icon, { name: 'x', size: 13 })),
      body);
  }

  // ---------- app ----------
  class App extends R.Component {
    constructor(props) {
      super(props);
      var t = todayIso(), monday = U.mondayOf(t);
      this.state = {
        data: derive(store.docs()), sync: store.info(), today: t, focus: t,
        // The grid renders days [rangeStart, rangeStart + rangeDays) and grows as you scroll toward either end.
        rangeStart: U.shiftIso(monday, -RANGE_LEAD), rangeDays: RANGE_INITIAL,
        viewStart: monday, viewEnd: U.shiftIso(monday, 13),
        sel: [], drag: null, adding: null, draft: '', draftCat: 'tc', draftRepeat: defaultRepeat(t),
        editing: null, colorFor: null, catFilter: null, newCat: '', renaming: null, confirmDel: null, clip: null,
        view: null, monthAnchor: null, yearAnchor: null, preview: null, reorder: null,
        ghost: [], ghostName: '', copied: false, xcopied: false,
        exportMode: false, exportDays: [], liveW: null, toast: null, canDownload: !window.claude
      };
      this.localW = U.loadColumnWidths();
      this.editingRef = null; this.renamingRef = null;
      this.leftIdx = RANGE_LEAD; // scroll position, in days from rangeStart
      this.pendingScrollTo = RANGE_LEAD;
    }
    componentDidMount() {
      var self = this;
      store.subscribe(function () { self.setState({ data: derive(store.docs()), sync: store.info() }); });
      this._up = function (e) { self.up(e); };
      this._cancel = function () { if (self.state.drag) self.setState({ drag: null }); };
      this._down = function (e) { self.blankDown(e); };
      this._key = function (e) { self.onKey(e); };
      this._copy = function (e) { self.onCopyEvent(e); };
      this._paste = function (e) { self.onPasteEvent(e); };
      window.addEventListener('pointerup', this._up);
      window.addEventListener('pointercancel', this._cancel);
      window.addEventListener('pointerdown', this._down, true);
      window.addEventListener('keydown', this._key);
      document.addEventListener('copy', this._copy);
      document.addEventListener('paste', this._paste);
      this._scrollClose = function (e) { if (self.state.preview && !(e.target && e.target.closest && e.target.closest('.rm-pop'))) self.setState({ preview: null }); };
      window.addEventListener('scroll', this._scrollClose, true);
      this.applyScroll();
      this._tick = setInterval(function () {
        var t = todayIso();
        if (t !== self.state.today) self.setState(function (st) { return { today: t, focus: st.focus === st.today ? t : st.focus }; });
      }, 60000);
      if (window.claude && window.claude.use) {
        window.claude.use('downloads').then(function (d) { self.downloads = d; self.setState({ canDownload: !!d }); });
      }
      store.start();
    }
    componentWillUnmount() {
      window.removeEventListener('pointerup', this._up);
      window.removeEventListener('pointercancel', this._cancel);
      window.removeEventListener('pointerdown', this._down, true);
      window.removeEventListener('keydown', this._key);
      document.removeEventListener('copy', this._copy);
      document.removeEventListener('paste', this._paste);
      window.removeEventListener('scroll', this._scrollClose, true);
      clearInterval(this._tick); clearTimeout(this._ct); clearTimeout(this._xt); clearTimeout(this._tt);
    }

    // ---------- writes ----------
    writePlan(next, prev) {
      var p = { id: next.id, exp: next.exp, date: next.date, text: next.text, cat: next.cat, done: !!next.done };
      if (next.series) p.series = next.series;
      if (prev && monthKey(prev.date) !== monthKey(p.date)) {
        var gone = {}; gone[prev.id] = null;
        store.patch('plans-' + monthKey(prev.date), { plans: gone });
      }
      var o = {}; o[p.id] = p;
      store.patch('plans-' + monthKey(p.date), { plans: o });
    }
    removePlan(p) { var o = {}; o[p.id] = null; store.patch('plans-' + monthKey(p.date), { plans: o }); }
    patchMeta(key, id, value) { var inner = {}, o = {}; inner[id] = value; o[key] = inner; store.patch('meta', o); }
    savePrefs(p) { store.patch('meta', { prefs: p }); }
    widths() {
      var p = this.state.data.prefs, live = this.state.liveW || {};
      return { day: live.day || p.dayWidth || this.localW.day, name: live.name || p.nameWidth || this.localW.name };
    }
    showToast(text, undo) {
      var self = this;
      clearTimeout(this._tt);
      this.setState({ toast: { text: text, undo: undo } });
      this._tt = setTimeout(function () { self.setState({ toast: null }); }, 8000);
    }

    // ---------- plan actions ----------
    toggle(id) {
      var p = this.state.data.plans.find(function (x) { return x.id === id; });
      if (p) this.writePlan(Object.assign({}, p, { done: !p.done }), p);
    }
    chipDown(p, e) {
      if (e.button !== undefined && e.button !== 0) return;
      if (this.state.editing) return;
      var multi = e.shiftKey || e.metaKey || e.ctrlKey;
      this.setState(function (st) {
        var sel = st.sel;
        if (multi) sel = sel.indexOf(p.id) >= 0 ? sel.filter(function (x) { return x !== p.id; }) : sel.concat(p.id);
        else if (sel.indexOf(p.id) < 0) sel = [p.id];
        return { sel: sel, drag: { kind: 'move', from: p.date, over: p.date }, adding: null, colorFor: null };
      });
    }
    enter(d) {
      var dr = this.state.drag;
      if (dr && dr.over !== d) this.setState({ drag: Object.assign({}, dr, { over: d }) });
    }
    up(e) {
      var st = this.state, dr = st.drag;
      if (!dr) return;
      if (dr.kind === 'move') {
        var delta = U.dayDiff(dr.from, dr.over);
        this.setState({ drag: null });
        if (delta === 0) return;
        var self0 = this;
        this.justDragged = true;
        setTimeout(function () { self0.justDragged = false; }, 0);
        if (e && e.altKey) {
          // Alt/Option-drag copies instead of moving
          var set = {};
          st.sel.forEach(function (id) { set[id] = 1; });
          var made = this.clonePlans(st.data.plans.filter(function (p) { return set[p.id]; }), delta, null);
          this.setState({ sel: made.map(function (p) { return p.id; }) });
        } else this.shiftSel(delta);
        return;
      }
      if (dr.kind === 'ghost') {
        var g = {};
        st.ghost.forEach(function (d) { g[d] = 1; });
        if (dr.from === dr.over) {
          if (g[dr.from]) delete g[dr.from]; else g[dr.from] = 1;
        } else {
          var a = dr.from < dr.over ? dr.from : dr.over, b = dr.from < dr.over ? dr.over : dr.from;
          for (var d = a; d <= b; d = U.shiftIso(d, 1)) g[d] = 1;
        }
        this.setState({ drag: null, ghost: Object.keys(g).sort() });
      }
    }
    shiftSel(n) {
      var self = this, sel = this.state.sel, plans = this.state.data.plans;
      var next = U.shiftPlans(plans, sel, n);
      plans.forEach(function (p, i) { if (next[i] !== p) self.writePlan(next[i], p); });
    }
    doneSel() {
      var self = this, set = {};
      this.state.sel.forEach(function (id) { set[id] = 1; });
      this.state.data.plans.forEach(function (p) { if (set[p.id] && !p.done) self.writePlan(Object.assign({}, p, { done: true }), p); });
      this.setState({ sel: [] });
    }
    deleteSel() {
      var self = this, set = {};
      this.state.sel.forEach(function (id) { set[id] = 1; });
      var gone = this.state.data.plans.filter(function (p) { return set[p.id]; });
      gone.forEach(function (p) { self.removePlan(p); });
      this.setState({ sel: [] });
      if (gone.length) {
        this.showToast('Deleted ' + gone.length + (gone.length === 1 ? ' step' : ' steps'), function () {
          gone.forEach(function (p) { self.writePlan(p, null); });
        });
      }
    }
    // A pointer-down on empty space clears picked days, selected steps and open pickers,
    // and saves a step that is being edited.
    blankDown(e) {
      var st = this.state, t = e.target;
      var inside = function (sel) { return !!(t && t.closest && t.closest(sel)); };
      if (st.editing && !inside('.rm-editform')) this.saveEditDraft();
      if (st.preview && !inside('.rm-pop')) this.setState({ preview: null });
      if (inside(KEEP_SELECTION)) return;
      var next = {};
      if (st.sel.length) next.sel = [];
      if (st.ghost.length) next.ghost = [];
      if (st.colorFor) next.colorFor = null;
      if (st.confirmDel) next.confirmDel = null;
      if (Object.keys(next).length) this.setState(next);
    }
    // ---------- endless timeline ----------
    // The grid holds a sliding range of days. Scrolling near either end adds RANGE_CHUNK days there
    // (and drops days far off the other side), shifting scrollLeft so the view does not jump.
    applyScroll() {
      var el = this.scrollEl, w = this.widths().day;
      if (!el) return;
      if (this.pendingScrollTo != null) {
        el.scrollLeft = this.pendingScrollTo * w; this.leftIdx = this.pendingScrollTo; this.pendingScrollTo = null;
      } else if (this.pendingShift) {
        el.scrollLeft += this.pendingShift * w; this.leftIdx += this.pendingShift;
      } else if (this.lastDayW && this.lastDayW !== w) {
        el.scrollLeft = this.leftIdx * w; // keep the same first day in view while column widths change
      }
      this.pendingShift = 0; this.lastDayW = w; this.extending = false;
      this.onScroll();
    }
    componentDidUpdate() { this.applyScroll(); }
    onScroll() {
      var el = this.scrollEl, st = this.state;
      if (!el) return;
      var w = this.widths();
      this.leftIdx = el.scrollLeft / w.day;
      var visible = Math.max(1, (el.clientWidth - w.name) / w.day);
      var vs = U.shiftIso(st.rangeStart, Math.floor(this.leftIdx + 0.02));
      var ve = U.shiftIso(st.rangeStart, Math.max(0, Math.ceil(this.leftIdx + visible - 0.02) - 1));
      if (vs !== st.viewStart || ve !== st.viewEnd) this.setState({ viewStart: vs, viewEnd: ve });
      if (this.extending) return;
      if (this.leftIdx < RANGE_EDGE) {
        this.extending = true;
        var trimRight = st.rangeDays + RANGE_CHUNK > RANGE_MAX ? RANGE_CHUNK : 0;
        this.pendingShift = RANGE_CHUNK;
        this.setState({ rangeStart: U.shiftIso(st.rangeStart, -RANGE_CHUNK), rangeDays: st.rangeDays + RANGE_CHUNK - trimRight });
      } else if (this.leftIdx + visible > st.rangeDays - RANGE_EDGE) {
        this.extending = true;
        var trimLeft = st.rangeDays + RANGE_CHUNK > RANGE_MAX && this.leftIdx > RANGE_CHUNK + RANGE_EDGE ? RANGE_CHUNK : 0;
        this.pendingShift = -trimLeft;
        this.setState({ rangeStart: U.shiftIso(st.rangeStart, trimLeft), rangeDays: st.rangeDays + RANGE_CHUNK - trimLeft });
      }
    }
    // Bring `date` to the left edge of the grid.
    scrollToDate(date, smooth) {
      var st = this.state, el = this.scrollEl, idx = U.dayDiff(st.rangeStart, date);
      if (!el || idx < RANGE_EDGE || idx > st.rangeDays - 2 * RANGE_EDGE) {
        this.pendingScrollTo = RANGE_LEAD;
        this.setState({ rangeStart: U.shiftIso(date, -RANGE_LEAD), rangeDays: RANGE_INITIAL });
        return;
      }
      if (smooth && el.scrollTo) el.scrollTo({ left: idx * this.widths().day, behavior: 'smooth' });
      else el.scrollLeft = idx * this.widths().day;
    }

    // ---------- reordering experiments ----------
    // Press on a running experiment's name cell and drag it up or down; Desk & meetings stays first.
    startReorder(exp, ev) {
      var self = this, t = ev.target;
      if (exp.desk || (ev.button !== undefined && ev.button !== 0)) return;
      if (t.closest && t.closest('button, input, .rm-palette, .rm-confirm')) return;
      var y0 = ev.clientY, live = false;
      var move = function (e) {
        if (!live && Math.abs(e.clientY - y0) < 5) return;
        live = true;
        document.documentElement.classList.add('rm-reordering');
        var rows = Array.prototype.slice.call(document.querySelectorAll('.rm-row[data-exp]'));
        var target = null, after = false;
        rows.forEach(function (r) {
          var b = r.getBoundingClientRect();
          if (e.clientY >= b.top && e.clientY < b.bottom) { target = r.getAttribute('data-exp'); after = e.clientY > b.top + b.height / 2; }
        });
        if (!target && rows.length) {
          var first = rows[0].getBoundingClientRect(), last = rows[rows.length - 1].getBoundingClientRect();
          if (e.clientY < first.top) { target = rows[0].getAttribute('data-exp'); after = false; }
          else if (e.clientY >= last.bottom) { target = rows[rows.length - 1].getAttribute('data-exp'); after = true; }
        }
        var cur = self.state.reorder;
        if (!cur || cur.over !== target || cur.after !== after) self.setState({ reorder: { id: exp.id, over: target, after: after } });
      };
      var up = function () {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        document.documentElement.classList.remove('rm-reordering');
        var r = self.state.reorder;
        if (live && r) self.finishReorder(r);
        if (self.state.reorder) self.setState({ reorder: null });
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    }
    togglePin(e) {
      var on = !e.pinned;
      this.patchMeta('exps', e.id, { pinned: on });
      this.showToast(on ? 'Pinned ' + e.name + '. It stays in place even when all its steps are done.' : 'Unpinned ' + e.name + '.');
    }
    finishReorder(r) {
      var st = this.state;
      if (!r.over || r.over === r.id) return;
      var running = splitExperiments(st.data.exps, st.data.plans).active.filter(function (e) { return !e.desk; });
      var ids = running.map(function (e) { return e.id; }).filter(function (id) { return id !== r.id; });
      var at = ids.indexOf(r.over);
      if (at < 0) return;
      ids.splice(r.after ? at + 1 : at, 0, r.id);
      var changes = {}, n = 0;
      ids.forEach(function (id, i) {
        var e = st.data.exps.find(function (x) { return x.id === id; });
        if (e && e.order !== i + 1) { changes[id] = { order: i + 1 }; n++; }
      });
      if (n) store.patch('meta', { exps: changes });
    }

    // ---------- views ----------
    view() { return this.state.view || this.state.data.prefs.view || 'week'; }
    setView(v) {
      var st = this.state, f = st.focus, next = { view: v, preview: null };
      if (v === 'month') next.monthAnchor = firstOfMonth(this.view() === 'week' && !(f >= st.viewStart && f <= st.viewEnd) ? st.viewStart : f);
      if (v === 'year') next.yearAnchor = U.fromIso(this.view() === 'month' && st.monthAnchor ? st.monthAnchor : f).getFullYear();
      if (v === 'week' && this.view() !== 'week') this.scrollToDate(U.mondayOf(this.view() === 'month' && st.monthAnchor && f.slice(0, 7) !== st.monthAnchor.slice(0, 7) ? st.monthAnchor : f), false);
      this.setState(next);
      if (v !== this.state.data.prefs.view) this.savePrefs({ view: v });
    }
    // Previous / next for the current view (week, month or year).
    step(dir) {
      var st = this.state, v = this.view();
      if (v === 'week') this.scrollToDate(dir < 0 ? U.mondayOf(U.shiftIso(st.viewStart, -1)) : U.shiftIso(U.mondayOf(st.viewStart), 7), true);
      else if (v === 'month') this.setState({ monthAnchor: addMonths(st.monthAnchor || firstOfMonth(st.today), dir), preview: null });
      else this.setState({ yearAnchor: (st.yearAnchor || U.fromIso(st.today).getFullYear()) + dir, preview: null });
    }
    goToday() {
      var t = this.state.today, v = this.view();
      if (v === 'week') { this.setState({ focus: t }); this.scrollToDate(U.mondayOf(t), true); }
      else this.setState({ focus: t, monthAnchor: firstOfMonth(t), yearAnchor: U.fromIso(t).getFullYear(), preview: null });
    }
    goMonth(d) {
      this.setState({ view: 'month', monthAnchor: firstOfMonth(d), focus: d, preview: null });
      if (this.state.data.prefs.view !== 'month') this.savePrefs({ view: 'month' });
    }
    showInTimeline(d) {
      this.setState({ view: 'week', focus: d, preview: null });
      this.scrollToDate(U.mondayOf(d), false);
      if (this.state.data.prefs.view !== 'week') this.savePrefs({ view: 'week' });
    }
    monthDayClick(d) {
      if (this.state.exportMode) this.toggleExportDay(d);
      else this.setState({ focus: d });
    }
    // Opens the details popover next to `el`, on its right if there is room, else on its left, else below.
    openPreview(kind, id, el) {
      var r = el.getBoundingClientRect(), W = 304, vw = window.innerWidth, vh = window.innerHeight;
      var pv = { kind: kind, id: id, side: 'right', left: r.right + 12 };
      if (pv.left + W > vw - 8) { pv.side = 'left'; pv.left = r.left - W - 12; }
      if (pv.left < 8) {
        pv.side = 'below'; pv.left = Math.max(8, Math.min(vw - W - 8, r.left + r.width / 2 - W / 2)); pv.top = r.bottom + 10;
        pv.arrow = Math.max(14, Math.min(W - 14, r.left + r.width / 2 - pv.left));
      } else {
        pv.top = Math.max(8, Math.min(vh - 440, r.top + r.height / 2 - 70));
        pv.arrow = Math.max(14, r.top + r.height / 2 - pv.top);
      }
      this.setState({ preview: pv });
    }

    // ---------- keyboard and clipboard ----------
    onKey(e) {
      var t = e.target, st = this.state;
      if (t && t.closest && t.closest('input, textarea, select, [contenteditable="true"]')) return;
      var mod = e.metaKey || e.ctrlKey;
      // Match the physical key too, so shortcuts work with any keyboard layout or input method.
      var isKey = function (ch) { return e.code === 'Key' + ch || (e.key || '').toUpperCase() === ch; };
      if (e.key === 'Escape') {
        this.setState({ sel: [], ghost: [], colorFor: null, confirmDel: null, adding: null, preview: null });
      } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !mod && !e.altKey && !st.sel.length && this.view() !== 'week') {
        e.preventDefault(); this.step(e.key === 'ArrowLeft' ? -1 : 1);
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && st.sel.length) {
        e.preventDefault(); this.deleteSel();
      } else if (mod && isKey('C') && st.sel.length && !this.textSelected()) {
        e.preventDefault(); this.keyAt = Date.now(); this.copySel(true);
      } else if (mod && isKey('V') && st.clip) {
        e.preventDefault(); this.keyAt = Date.now(); this.pasteHere();
      }
    }
    textSelected() { return !!(window.getSelection && String(window.getSelection())); }
    // Backups for when the shortcut reaches the page only as a copy/paste event (Edit menu, some browsers).
    onCopyEvent(e) {
      var t = e.target;
      if (Date.now() - (this.keyAt || 0) < 400 || !this.state.sel.length || this.textSelected()) return;
      if (t && t.closest && t.closest('input, textarea, select')) return;
      var text = this.copySel(false);
      if (e.clipboardData && text) { e.clipboardData.setData('text/plain', text); e.preventDefault(); }
    }
    onPasteEvent(e) {
      var t = e.target;
      if (Date.now() - (this.keyAt || 0) < 400 || !this.state.clip) return;
      if (t && t.closest && t.closest('input, textarea, select')) return;
      e.preventDefault(); this.pasteHere();
    }
    pasteHere() {
      if (this.hoverCell) this.pasteAt(this.hoverCell.exp, this.hoverCell.date);
      else this.showToast('Point at a day in the grid, then press ' + MOD + 'V.');
    }
    clonePlans(src, delta, exp) {
      var self = this;
      var made = src.map(function (p) { return { id: newId('p'), exp: exp || p.exp, date: U.shiftIso(p.date, delta), text: p.text, cat: p.cat, done: false }; });
      made.forEach(function (p) { self.writePlan(p, null); });
      return made;
    }
    // Copies the selected steps for pasting here, and (when writeSystem) puts their text on the system clipboard.
    copySel(writeSystem) {
      var set = {};
      this.state.sel.forEach(function (id) { set[id] = 1; });
      var clip = this.state.data.plans.filter(function (p) { return set[p.id]; });
      if (!clip.length) return '';
      var text = clip.map(function (p) { return p.text; }).join('\n');
      if (writeSystem) copyText(text);
      this.setState({ clip: clip });
      this.showToast('Copied ' + clip.length + (clip.length === 1 ? ' step' : ' steps') + '. Point at a day and press ' + MOD + 'V, or click Paste on it.');
      return text;
    }
    // Pastes the copied steps so the earliest lands on `date`. Steps copied from one experiment go into
    // the target row; steps from several experiments stay in their own rows.
    pasteAt(exp, date) {
      var self = this, clip = this.state.clip;
      if (!clip || !clip.length) return;
      var base = clip.reduce(function (m, p) { return p.date < m ? p.date : m; }, clip[0].date);
      var oneExp = clip.every(function (p) { return p.exp === clip[0].exp; });
      var made = this.clonePlans(clip, U.dayDiff(base, date), oneExp ? exp : null);
      this.setState({ sel: made.map(function (p) { return p.id; }) });
      this.showToast('Pasted ' + made.length + (made.length === 1 ? ' step' : ' steps'), function () {
        made.forEach(function (p) { self.removePlan(p); });
        self.setState({ sel: [] });
      });
    }
    startAdd(exp, d) {
      var mine = this.state.data.plans.filter(function (p) { return p.exp === exp; });
      var last = mine[mine.length - 1];
      this.setState({ adding: { exp: exp, date: d }, draft: '', draftCat: last ? last.cat : 'none', draftRepeat: defaultRepeat(d), sel: [] });
    }
    // Writes repeats of `p` on each date in `dates`, linked to p's series (created if p has none).
    addRepeats(p, dates) {
      var self = this;
      if (!dates.length) return [];
      var series = p.series || newId('s');
      if (!p.series) this.writePlan(Object.assign({}, p, { series: series }), p);
      var made = dates.map(function (d) { return { id: newId('p'), exp: p.exp, date: d, text: p.text, cat: p.cat, done: false, series: series }; });
      made.forEach(function (x) { self.writePlan(x, null); });
      return made;
    }
    commitAdd() {
      var self = this, st = this.state, t = (st.draft || '').trim();
      if (!st.adding || !t) { this.setState({ adding: null }); return; }
      var p = { id: newId('p'), exp: st.adding.exp, date: st.adding.date, text: t, cat: st.draftCat, done: false };
      this.writePlan(p, null);
      var made = this.addRepeats(p, repeatDates(p.date, st.draftRepeat));
      this.setState({ adding: null, draft: '' });
      if (made.length) {
        var all = made.concat(p);
        this.showToast('Added ' + all.length + ' steps through ' + U.shortDate(made[made.length - 1].date), function () { all.forEach(function (x) { self.removePlan(x); }); });
      }
    }
    // Later steps in the same repeat series as p.
    laterRepeats(p) {
      if (!p.series) return [];
      return this.state.data.plans.filter(function (x) { return x.series === p.series && x.id !== p.id && x.date > p.date; });
    }
    startEdit(p) { this.editingRef = p.id; this.editDraft = null; this.setState({ editing: p.id, sel: [], drag: null }); }
    // d: { text, cat, repeat, later } from the step editor
    commitEdit(p, d) {
      var self = this;
      if (this.editingRef !== p.id) return;
      this.editingRef = null; this.editDraft = null;
      var t = (d.text || '').trim() || p.text, cat = d.cat || p.cat;
      var next = Object.assign({}, p, { text: t, cat: cat });
      if (t !== p.text || cat !== p.cat) this.writePlan(next, p);
      if (d.later && (t !== p.text || cat !== p.cat)) {
        this.laterRepeats(p).forEach(function (x) { self.writePlan(Object.assign({}, x, { text: t, cat: cat }), x); });
      }
      var made = this.addRepeats(next, repeatDates(p.date, d.repeat));
      this.setState({ editing: null });
      if (made.length) {
        this.showToast('Added ' + made.length + (made.length === 1 ? ' repeat' : ' repeats') + ' through ' + U.shortDate(made[made.length - 1].date), function () { made.forEach(function (x) { self.removePlan(x); }); });
      }
    }
    saveEditDraft() {
      var id = this.state.editing, d = this.editDraft;
      var p = this.state.data.plans.find(function (x) { return x.id === id; });
      if (p && d) this.commitEdit(p, d); else this.cancelEdit();
    }
    cancelEdit() { this.editingRef = null; this.editDraft = null; this.setState({ editing: null }); }
    deleteStep(p, withLater) {
      var self = this;
      var gone = [p].concat(withLater ? this.laterRepeats(p) : []);
      this.cancelEdit();
      gone.forEach(function (x) { self.removePlan(x); });
      this.showToast('Deleted ' + gone.length + (gone.length === 1 ? ' step' : ' steps'), function () { gone.forEach(function (x) { self.writePlan(x, null); }); });
    }

    // ---------- experiments & categories ----------
    setColor(id, hex) { this.patchMeta('exps', id, { color: hex }); this.setState({ colorFor: null }); }
    commitRename(e, value) {
      if (this.renamingRef !== e.id) return;
      this.renamingRef = null;
      var t = (value || '').trim();
      if (t && t !== e.name) this.patchMeta('exps', e.id, { name: t });
      this.setState({ renaming: null });
    }
    // Creates an experiment from the New experiment row. With no days picked it needs a name and makes an
    // empty row (add steps later with + on any day); with picked days it also adds a "Plan step" on each.
    createExp() {
      var self = this, st = this.state, exps = st.data.exps, name = (st.ghostName || '').trim();
      if (!st.ghost.length && !name) {
        var field = document.getElementById('rm-ghostname');
        if (field) field.focus();
        return;
      }
      var id = newId('x');
      var order = exps.reduce(function (m, e) { return Math.max(m, e.order || 0); }, 0) + 1;
      this.patchMeta('exps', id, { id: id, name: name || 'New experiment', color: U.nextExperimentColor(exps), order: order });
      st.ghost.forEach(function (d) { self.writePlan({ id: newId('p'), exp: id, date: d, text: 'Plan step', cat: 'none', done: false }, null); });
      this.setState({ ghost: [], ghostName: '' });
      if (!st.ghost.length) this.showToast('Created ' + name + '. Point at a day in its row and click + to add a step.');
    }
    deleteExp(e) {
      var self = this;
      var exp = Object.assign({}, e);
      var gone = this.state.data.plans.filter(function (p) { return p.exp === e.id; });
      gone.forEach(function (p) { self.removePlan(p); });
      this.patchMeta('exps', e.id, null);
      this.setState({ confirmDel: null, colorFor: null, sel: [] });
      this.showToast('Deleted ' + e.name, function () {
        self.patchMeta('exps', exp.id, exp);
        gone.forEach(function (p) { self.writePlan(p, null); });
      });
    }
    addCat() {
      var cats = this.state.data.cats, name = (this.state.newCat || '').trim();
      if (!name) return;
      var nCustom = cats.filter(function (c) { return c.custom; }).length;
      var id = newId('c');
      var tag = name.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || 'XX';
      var order = cats.reduce(function (m, c) { return Math.max(m, c.order || 0); }, 0) + 1;
      var colors = RM.CUSTOM_CATEGORY_COLORS;
      this.patchMeta('cats', id, { id: id, name: name, tag: tag, color: colors[nCustom % colors.length], group: 'bench', custom: true, order: order });
      this.setState({ newCat: '' });
    }

    // ---------- columns ----------
    startResize(kind, e) {
      var self = this, startW = this.widths()[kind];
      this.setState({ drag: null });
      U.startColumnResize(e, {
        kind: kind, startWidth: startW,
        onChange: function (w) { self.setState(function (st) { var l = Object.assign({}, st.liveW); l[kind] = w; return { liveW: l }; }); },
        onEnd: function (w) {
          if (w !== startW) {
            self.savePrefs(kind === 'day' ? { dayWidth: w, density: null } : { nameWidth: w });
            var all = self.widths(); all[kind] = w; U.saveColumnWidths(all); self.localW = all;
          }
          self.setState({ liveW: null });
        }
      });
    }
    resetWidth(kind) {
      var init = U.COLUMN_LIMITS[kind].initial;
      this.savePrefs(kind === 'day' ? { dayWidth: init, density: 'comfortable' } : { nameWidth: init });
      var all = this.widths(); all[kind] = init; U.saveColumnWidths(all); this.localW = all;
    }
    nudgeName(delta) { this.savePrefs({ nameWidth: U.clampWidth('name', this.widths().name + delta) }); }
    setDensity(d) { this.savePrefs({ density: d, dayWidth: DENSITY[d] }); }

    // ---------- copy / export ----------
    copy(text) {
      var self = this;
      copyText(text);
      this.setState({ copied: true });
      clearTimeout(this._ct);
      this._ct = setTimeout(function () { self.setState({ copied: false }); }, 1600);
    }
    copyExport(text) {
      var self = this;
      copyText(text);
      this.setState({ xcopied: true });
      clearTimeout(this._xt);
      this._xt = setTimeout(function () { self.setState({ xcopied: false }); }, 1600);
    }
    download(text, days, format) {
      var name = U.notebookFilename(days, format);
      if (this.downloads) this.downloads.save({ filename: name, data: text }).catch(function () {});
      else U.downloadText(name, text, format === 'text' ? 'text/plain' : 'text/markdown');
    }
    exportPrefs() { return Object.assign({}, EXPORT_DEFAULTS, this.state.data.prefs.export || {}); }
    setExportPref(k, v) { var o = {}; o[k] = v; this.savePrefs({ export: o }); }
    openExport() {
      var st = this.state;
      if (st.exportMode) { this.setState({ exportMode: false }); return; }
      var ds = [], from = U.mondayOf(st.viewStart);
      for (var i = 0; i < N_DAYS; i++) {
        var d = U.shiftIso(from, i);
        if (d <= st.today && st.data.plans.some(function (p) { return p.date === d; })) ds.push(d);
      }
      this.setState({ exportMode: true, exportDays: ds, sel: [], adding: null, colorFor: null });
    }
    toggleExportDay(d) {
      this.setState(function (st) {
        var a = st.exportDays.slice(), i = a.indexOf(d);
        if (i >= 0) a.splice(i, 1); else a.push(d);
        a.sort();
        return { exportDays: a };
      });
    }
    setExportRange(a, b) {
      var ds = [];
      for (var d = a; d <= b; d = U.shiftIso(d, 1)) ds.push(d);
      this.setState({ exportDays: ds });
    }

    // ---------- render ----------
    render() {
      var self = this, s = this.state, data = s.data, today = s.today;
      var cats = data.cats, exps = data.exps, plans = data.plans, notes = data.notes;
      var w = this.widths();
      var gridCols = w.name + 'px repeat(' + s.rangeDays + ', ' + w.day + 'px)';
      var rowStyle = { gridTemplateColumns: gridCols };

      var dates = [];
      for (var i = 0; i < s.rangeDays; i++) dates.push(U.shiftIso(s.rangeStart, i));
      // the 14 days offered in the export panel: two weeks from the Monday of the first day in view
      var view = this.view();
      var exportFrom = U.mondayOf(view === 'week' ? s.viewStart : s.focus), exportDates = [];
      for (var xi = 0; xi < N_DAYS; xi++) exportDates.push(U.shiftIso(exportFrom, xi));
      var bandLabel = { position: 'sticky', left: w.name + 10, display: 'inline-flex', gap: 6, alignItems: 'center', whiteSpace: 'nowrap' };

      var allCats = cats.concat(NO_CAT);
      var catMap = U.categoryMap(allCats);
      var expMap = {};
      exps.forEach(function (e) { expMap[e.id] = e; });
      var byKey = {}, byDate = {}, byExp = {};
      plans.forEach(function (p) {
        var k = p.exp + '|' + p.date;
        (byKey[k] = byKey[k] || []).push(p);
        (byDate[p.date] = byDate[p.date] || []).push(p);
        (byExp[p.exp] = byExp[p.exp] || []).push(p);
      });
      var dayDone = function (d) { return U.isDayDone(byDate[d] || [], d); };
      var firstDate = function (id) { var f = null; (byExp[id] || []).forEach(function (p) { if (!f || p.date < f) f = p.date; }); return f; };

      var dr = s.drag;
      var selSet = {};
      s.sel.forEach(function (id) { selSet[id] = 1; });
      var delta = dr && dr.kind === 'move' ? U.dayDiff(dr.from, dr.over) : 0;
      var dropKeys = {};
      var dropDates = {};
      if (delta !== 0) plans.forEach(function (p) { if (selSet[p.id]) { dropKeys[p.exp + '|' + U.shiftIso(p.date, delta)] = 1; dropDates[U.shiftIso(p.date, delta)] = 1; } });
      var ghostSet = {};
      s.ghost.forEach(function (d) { ghostSet[d] = 1; });
      if (dr && dr.kind === 'ghost') {
        var ga = dr.from < dr.over ? dr.from : dr.over, gb = dr.from < dr.over ? dr.over : dr.from;
        for (var gd = ga; gd <= gb; gd = U.shiftIso(gd, 1)) ghostSet[gd] = 1;
      }
      var catOptions = allCats.map(function (c) { return h('option', { key: c.id, value: c.id }, c.name); });

      var planItem = function (p) {
        if (s.editing === p.id) {
          return h(StepEditor, {
            key: p.id, plan: p, options: catOptions, later: self.laterRepeats(p).length,
            onDraft: function (d) { self.editDraft = d; },
            onSave: function (d) { self.commitEdit(p, d); },
            onCancel: function () { self.cancelEdit(); },
            onDelete: function (withLater) { self.deleteStep(p, withLater); }
          });
        }
        return h(RM.PlanItem, {
          key: p.id, text: p.text, category: catMap[p.cat] || NO_CAT, done: p.done, selected: !!selSet[p.id],
          dimmed: !!s.catFilter && s.catFilter !== p.cat,
          onToggle: function () { self.toggle(p.id); },
          onPointerDown: function (e) { self.chipDown(p, e); },
          onDoubleClick: function () { self.startEdit(p); }
        });
      };
      var nClip = s.clip ? s.clip.length : 0;

      var addForm = function () {
        return h('div', { className: 'rm-addform', onPointerDown: stop },
          h('input', {
            id: 'rm-addstep', autoFocus: true, value: s.draft, placeholder: 'New step…', 'aria-label': 'New plan step',
            onChange: function (e) { self.setState({ draft: e.target.value }); },
            onKeyDown: function (e) { if (e.key === 'Enter') { e.preventDefault(); self.commitAdd(); } else if (e.key === 'Escape') self.setState({ adding: null }); }
          }),
          h('select', { value: s.draftCat, 'aria-label': 'Category', onChange: function (e) { self.setState({ draftCat: e.target.value }); } }, catOptions),
          h(RepeatFields, { start: s.adding.date, value: s.draftRepeat, onChange: function (v) { self.setState({ draftRepeat: v }); } }),
          h('div', { className: 'rm-addform-actions' },
            h('button', { type: 'button', onClick: function () { self.setState({ adding: null }); } }, 'Cancel'),
            h('button', { type: 'button', className: 'is-go', onClick: function () { self.commitAdd(); } }, 'Add')));
      };

      var nameCell = function (e, completed, meta) {
        var name = e.name;
        if (s.renaming === e.id) {
          name = h('input', {
            autoFocus: true, defaultValue: e.name, 'aria-label': 'Rename experiment', onPointerDown: stop,
            onKeyDown: function (ev) {
              if (ev.key === 'Enter') self.commitRename(e, ev.currentTarget.value);
              else if (ev.key === 'Escape') { self.renamingRef = null; self.setState({ renaming: null }); }
            },
            onBlur: function (ev) { self.commitRename(e, ev.currentTarget.value); }
          });
        }
        var nSteps = (byExp[e.id] || []).length;
        return h('div', {
          className: 'rm-expwrap' + (e.desk || completed ? '' : ' is-movable'), title: e.desk ? undefined : completed ? 'Double-click the name to rename' : 'Drag to reorder · double-click the name to rename',
          onPointerDown: e.desk || completed ? undefined : function (ev) { self.startReorder(e, ev); },
          onDoubleClick: e.desk ? undefined : function (ev) {
            if (ev.target.closest && ev.target.closest('.rm-palette, .rm-swatch, .rm-confirm, button, input')) return;
            self.renamingRef = e.id; self.setState({ renaming: e.id, colorFor: null });
          }
        }, h(RM.ExperimentLabel, {
          name: name, meta: meta, color: e.color, desk: !!e.desk, completed: completed,
          paletteOpen: s.colorFor === e.id,
          onColorClick: function () { self.setState({ colorFor: s.colorFor === e.id ? null : e.id }); },
          onColorChange: function (hex) { self.setColor(e.id, hex); }
        }),
        e.desk || completed ? null : h('span', { className: 'rm-exp-grip', 'aria-hidden': 'true' }),
        e.desk || s.renaming === e.id ? null : h('button', {
          type: 'button', className: 'rm-exp-pin' + (e.pinned ? ' is-on' : ''), 'aria-pressed': e.pinned ? 'true' : 'false',
          title: e.pinned ? 'Pinned: stays here when all steps are done. Click to unpin.' : 'Pin: keep this experiment in place when all its steps are done',
          'aria-label': (e.pinned ? 'Unpin ' : 'Pin ') + e.name,
          onClick: function () { self.togglePin(e); }
        }, h(PinIcon, { size: 13, filled: !!e.pinned })),
        e.desk || s.renaming === e.id ? null : h('button', {
          type: 'button', className: 'rm-exp-del', title: 'Delete experiment', 'aria-label': 'Delete ' + e.name,
          onClick: function () { self.setState({ confirmDel: e.id, colorFor: null }); }
        }, h(RM.Icon, { name: 'x', size: 13 })),
        s.confirmDel === e.id ? h('div', { className: 'rm-confirm', role: 'group', 'aria-label': 'Delete experiment' },
          h('div', null, nSteps ? 'Delete this experiment and its ' + nSteps + (nSteps === 1 ? ' step?' : ' steps?') : 'Delete this experiment?'),
          h('div', { className: 'rm-gname-acts' },
            h(RM.Button, { size: 'sm', onClick: function () { self.setState({ confirmDel: null }); } }, 'Cancel'),
            h(RM.Button, { size: 'sm', variant: 'primary', onClick: function () { self.deleteExp(e); } }, 'Delete'))) : null);
      };

      var mkRow = function (e, completed) {
        var all = byExp[e.id] || [];
        var nDone = all.filter(function (p) { return p.done; }).length;
        var first = firstDate(e.id);
        var meta = e.desk ? 'Analysis · slides · meetings' : !all.length ? 'No steps yet' : (nDone === all.length ? 'All ' + all.length + ' steps done' : nDone + ' of ' + all.length + ' steps done');
        var cells = dates.map(function (d) {
          var k = e.id + '|' + d, ps = byKey[k] || [];
          var adding = !!(s.adding && s.adding.exp === e.id && s.adding.date === d);
          return h(RM.DayCell, {
            key: d, laneColor: completed || e.desk ? undefined : e.color, today: d === today, dayDone: dayDone(d),
            dropTarget: !!dropKeys[k], addLabel: 'Add a step to ' + e.name + ' on ' + U.shortDate(d),
            onAdd: adding ? undefined : function () { self.startAdd(e.id, d); },
            onPointerEnter: function () { self.enter(d); self.hoverCell = { exp: e.id, date: d }; }
          },
            ps.length ? h(RM.PlanCard, {
              dayOffset: !e.desk && first ? U.dayDiff(first, d) : null,
              allDone: ps.every(function (p) { return p.done; })
            }, ps.map(planItem)) : null,
            adding ? addForm() : null,
            nClip && !adding ? h('button', {
              type: 'button', className: 'rm-cell-tool rm-paste', onPointerDown: stop,
              'aria-label': 'Paste ' + nClip + (nClip === 1 ? ' step' : ' steps') + ' on ' + U.shortDate(d),
              onClick: function () { self.pasteAt(e.id, d); }
            }, 'Paste') : null);
        });
        var ro = s.reorder;
        var rcls = ro ? (ro.id === e.id ? ' is-moving' : ro.over === e.id && ro.over !== ro.id ? (ro.after ? ' is-drop-after' : ' is-drop-before') : '') : '';
        return h('div', { key: e.id, className: 'rm-row' + (completed ? ' is-completed' : '') + rcls, style: rowStyle, 'data-exp': e.desk || completed ? undefined : e.id }, nameCell(e, completed, meta), cells);
      };

      var sorted = splitExperiments(exps, plans);
      var active = sorted.active, finished = sorted.completed;

      var ghostRow = h('div', { key: 'ghost', className: 'rm-row', style: rowStyle },
        h('div', { className: 'rm-gname' },
          h('div', { className: 'rm-gname-t' }, h(RM.Icon, { name: 'plus', size: 14, strokeWidth: 2.2 }), 'New experiment'),
          h('input', {
            id: 'rm-ghostname', className: 'rm-field', placeholder: 'Experiment name', value: s.ghostName, 'aria-label': 'Experiment name',
            onChange: function (e) { self.setState({ ghostName: e.target.value }); },
            onKeyDown: function (e) { if (e.key === 'Enter') { e.preventDefault(); self.createExp(); } }
          }),
          h('div', { className: 'rm-gname-s' }, s.ghost.length
            ? 'Adds a step on ' + s.ghost.length + (s.ghost.length === 1 ? ' day: ' : ' days: ') + s.ghost.map(U.shortDate).join(', ')
            : 'Create it empty, or first drag across days (or click separate days) to add steps too.'),
          h('div', { className: 'rm-gname-acts' },
            s.ghost.length ? h(RM.Button, { size: 'sm', onClick: function () { self.setState({ ghost: [] }); } }, 'Clear days') : null,
            h(RM.Button, { size: 'sm', variant: 'primary', icon: 'plus', onClick: function () { self.createExp(); } }, 'Create'))),
        dates.map(function (d) {
          return h(RM.GhostCell, {
            key: d, selected: !!ghostSet[d], label: 'Select ' + U.shortDate(d) + ' for a new experiment',
            onPointerDown: function (e) { if (e.button !== undefined && e.button !== 0) return; self.setState({ drag: { kind: 'ghost', from: d, over: d }, sel: [] }); },
            onPointerEnter: function () { self.enter(d); },
            onToggle: function () { self.setState(function (st) { var g = st.ghost.indexOf(d) >= 0 ? st.ghost.filter(function (x) { return x !== d; }) : st.ghost.concat(d).sort(); return { ghost: g }; }); }
          });
        }));

      var rows;
      if (!s.sync.ready) {
        rows = [h('div', { key: 'loading', className: 'rm-row', style: rowStyle }, h('div', { className: 'rm-loading', style: { gridColumn: '1 / -1' } }, h('span', null, 'Loading your board…')))];
      } else {
        rows = active.map(function (e) { return mkRow(e, false); });
        rows.push(ghostRow);
        if (finished.length) {
          rows.push(h('div', { key: 'divider', className: 'rm-row', style: rowStyle }, h('div', { className: 'rm-divider', style: { gridColumn: '1 / -1' } }, h('span', null, 'Completed · ' + finished.length))));
          finished.forEach(function (e) { rows.push(mkRow(e, true)); });
        }
      }

      // header bands
      var months = [], weeks = [];
      dates.forEach(function (d) {
        var dt = U.fromIso(d);
        var ml = MONL[dt.getMonth()] + ' ' + dt.getFullYear();
        var lm = months[months.length - 1];
        if (lm && lm.label === ml) lm.span++; else months.push({ label: ml, span: 1 });
        var wl = 'W' + U.isoWeek(dt);
        var lw = weeks[weeks.length - 1];
        if (lw && lw.label === wl) { lw.span++; lw.end = d; } else weeks.push({ label: wl, span: 1, startD: d, end: d });
      });
      weeks.forEach(function (wk) {
        var a = U.fromIso(wk.startD), b = U.fromIso(wk.end);
        wk.range = MON[a.getMonth()] + ' ' + a.getDate() + '–' + (a.getMonth() === b.getMonth() ? '' : MON[b.getMonth()] + ' ') + b.getDate();
      });

      var header = [
        h('div', { key: 'm', className: 'rm-row', style: rowStyle },
          h('div', { className: 'rm-band is-blank' }),
          months.map(function (m) { return h('div', { key: m.label, className: 'rm-band', style: { gridColumn: 'span ' + m.span } }, h('span', { style: bandLabel }, m.label)); })),
        h('div', { key: 'w', className: 'rm-row', style: rowStyle },
          h('div', { className: 'rm-band is-week is-blank' }),
          weeks.map(function (wk) { return h('div', { key: wk.label + wk.startD, className: 'rm-band is-week', style: { gridColumn: 'span ' + wk.span } }, h('span', { style: bandLabel }, h('span', { className: 'rm-tag' }, wk.label), h('span', null, wk.range))); })),
        h('div', { key: 'd', className: 'rm-row', style: rowStyle },
          h('div', { className: 'rm-namehead' }, 'Experiments',
            h(RM.ResizeHandle, {
              label: 'Experiment column width', value: w.name,
              onResizeStart: function (e) { self.startResize('name', e); },
              onReset: function () { self.resetWidth('name'); },
              onNudge: function (dl) { self.nudgeName(dl); }
            })),
          dates.map(function (d) {
            var a = byDate[d] || [], dn = a.filter(function (p) { return p.done; }).length;
            return h(RM.DayHeader, {
              key: d, date: d, today: d === today, allDone: dayDone(d),
              focused: !s.exportMode && d === s.focus,
              exportSelected: s.exportMode ? s.exportDays.indexOf(d) >= 0 : undefined,
              stat: a.length ? (dayDone(d) ? 'all done' : dn + '/' + a.length) : '—',
              onClick: function () { if (self.state.exportMode) self.toggleExportDay(d); else self.setState({ focus: d }); },
              onPointerEnter: function () { self.enter(d); },
              onResizeStart: function (e) { self.startResize('day', e); },
              onResizeReset: function () { self.resetWidth('day'); },
              width: w.day
            });
          }))
      ];

      // side panel
      var panel;
      if (s.exportMode) {
        var xp = this.exportPrefs();
        var exportText = U.buildNotebook({
          days: s.exportDays, plans: plans, exps: exps, cats: allCats, notes: notes,
          group: xp.group, format: xp.format, includeOpen: xp.includeOpen, includeNotes: xp.includeNotes, includeDesk: xp.includeDesk
        }).replace(/ _\(No category\)_$/gm, '').replace(/ \(No category\)$/gm, '');
        var monday = U.mondayOf(today);
        panel = h(RM.NotebookExport, {
          days: exportDates.map(function (d) { return { date: d, selected: s.exportDays.indexOf(d) >= 0, hasContent: !!(byDate[d] && byDate[d].length) || !!(notes[d] || '').trim() }; }),
          onToggleDay: function (d) { self.toggleExportDay(d); },
          presets: [
            { label: 'Today', onClick: function () { self.setState({ exportDays: [today] }); } },
            { label: 'This week', onClick: function () { self.setExportRange(monday, U.shiftIso(monday, 6)); } },
            { label: 'Last 7 days', onClick: function () { self.setExportRange(U.shiftIso(today, -6), today); } },
            { label: 'All 14', onClick: function () { self.setState({ exportDays: exportDates.slice() }); } },
            { label: 'Clear', onClick: function () { self.setState({ exportDays: [] }); } }
          ],
          group: xp.group, onGroupChange: function (g) { self.setExportPref('group', g); },
          format: xp.format, onFormatChange: function (f) { self.setExportPref('format', f); },
          includeOpen: xp.includeOpen, includeNotes: xp.includeNotes, includeDesk: xp.includeDesk,
          onOptionChange: function (k, v) { self.setExportPref(k, v); },
          preview: exportText, copied: s.xcopied,
          onCopy: function () { self.copyExport(exportText); },
          onDownload: s.canDownload ? function () { self.download(exportText, s.exportDays, xp.format); } : undefined,
          onClose: function () { self.setState({ exportMode: false }); }
        });
      } else {
        var sum = dailyByCategory(s.focus, byDate[s.focus] || [], exps, allCats, catMap, notes);
        var fd = U.fromIso(s.focus);
        panel = h(RM.DailyNote, {
          dateLabel: DOW[fd.getDay()] + ', ' + MON[fd.getMonth()] + ' ' + fd.getDate(),
          sections: sum.sections.map(function (sec) {
            return Object.assign({}, sec, {
              items: sec.items.map(function (p) {
                var ex = expMap[p.exp] || { name: '', color: 'var(--exp-desk)' };
                return Object.assign({}, p, { experimentName: ex.name, experimentColor: ex.color });
              })
            });
          }),
          done: sum.done, total: sum.total, categories: allCats,
          notes: notes[s.focus] || '', notesId: 'rm-daynote', summary: sum.text, copied: s.copied,
          onPrev: function () { self.setState({ focus: U.shiftIso(s.focus, -1) }); },
          onNext: function () { self.setState({ focus: U.shiftIso(s.focus, 1) }); },
          onToggle: function (id) { self.toggle(id); },
          onNotesChange: function (text) { var o = {}; o[s.focus] = text; store.patch('notes-' + monthKey(s.focus), { notes: o }); },
          onCopy: function () { self.copy(sum.text); }
        });
      }

      var a0 = U.fromIso(s.viewStart), a1 = U.fromIso(s.viewEnd);
      var nActive = active.filter(function (e) { return !e.desk; }).length;
      var td = U.fromIso(today);
      var density = data.prefs.density === undefined && !data.prefs.dayWidth ? 'comfortable' : data.prefs.density;

      var expOrder = {};
      exps.forEach(function (e, i) { expOrder[e.id] = i; });
      var ctx = {
        today: today, plans: plans, exps: exps, expMap: expMap, catMap: catMap, byDate: byDate, byExp: byExp, expOrder: expOrder,
        selSet: selSet, dropDates: dropDates, dayDone: dayDone, stats: experimentStats(exps, byExp, today)
      };
      var board = view === 'month' ? renderMonth(this, ctx) : view === 'year' ? renderYear(this, ctx)
        : h('section', { className: 'rm-board', 'aria-label': 'Roadmap grid', onPointerLeave: function () { self.hoverCell = null; } },
          h('div', { className: 'rm-scroll', ref: function (el) { self.scrollEl = el; }, onScroll: function () { self.onScroll(); } }, h('div', { className: 'rm-grid' }, header, rows)));
      var anchorM = U.fromIso(s.monthAnchor || firstOfMonth(today));
      var rangeText = view === 'month' ? MONL[anchorM.getMonth()] + ' ' + anchorM.getFullYear()
        : view === 'year' ? String(s.yearAnchor || U.fromIso(today).getFullYear())
        : MON[a0.getMonth()] + ' ' + a0.getDate() + ' – ' + MON[a1.getMonth()] + ' ' + a1.getDate() + ', ' + a1.getFullYear();
      var unit = view === 'week' ? 'week' : view;
      var hints = view === 'month' ? [['Click', ' a step or bar for details'], ['Drag', ' a step to another day'], ['Click a day', ' for its note']]
        : view === 'year' ? [['Click a day', ' to open its month'], ['Click an experiment', ' for its progress'], ['← →', ' change year']]
        : [['Drag', ' a plan to move it'], [MOD + 'C ' + MOD + 'V', ' to copy'], ['Shift-click', ' to select several'], ['Double-click', ' to edit or delete']];

      return h('div', { className: 'rm-app rm-root' },
        h('header', { className: 'rm-top' },
          h('div', { className: 'rm-brand' },
            h('div', { className: 'rm-logo', 'aria-hidden': 'true' }, h(RM.Icon, { name: 'flask', size: 20 })),
            h('div', null,
              h('h1', null, 'Experiment roadmap'),
              h('p', { className: 'rm-sub' },
                h('span', null, nActive + ' running · ' + finished.length + ' completed · today is ' + DOW[td.getDay()] + ' ' + U.shortDate(today)),
                h('span', { className: 'rm-sync is-' + s.sync.tone, role: 'status' }, h('i', { 'aria-hidden': 'true' }), s.sync.text)))),
          s.sel.length
            // SelectionBar from the design system, plus Copy
            ? h('div', { className: 'rm-selbar', role: 'toolbar', 'aria-label': 'Selected plans' },
              h('span', null, s.sel.length + (s.sel.length === 1 ? ' plan selected' : ' plans selected')),
              h(RM.Button, { variant: 'inverse', icon: 'chevron-left', onClick: function () { self.shiftSel(-1); } }, '1 day earlier'),
              h(RM.Button, { variant: 'inverse', onClick: function () { self.shiftSel(1); } }, '1 day later', h(RM.Icon, { name: 'chevron-right', size: 14 })),
              h(RM.Button, { variant: 'inverse', icon: 'copy', onClick: function () { self.copySel(); } }, 'Copy'),
              h(RM.Button, { variant: 'inverse', onClick: function () { self.doneSel(); } }, 'Mark done'),
              h(RM.Button, { variant: 'inverse', onClick: function () { self.deleteSel(); } }, 'Delete'),
              h(RM.Button, { variant: 'inverse', iconOnly: true, icon: 'x', 'aria-label': 'Clear selection', onClick: function () { self.setState({ sel: [] }); } }))
            : h('div', { className: 'rm-hint' }, hints.map(function (x) { return h('span', { key: x[0] }, h('b', null, x[0]), x[1]); })),
          h('div', { className: 'rm-nav' },
            h('div', { className: 'rm-views', role: 'radiogroup', 'aria-label': 'View' }, VIEWS.map(function (o) {
              var on = o.value === view;
              return h('button', { key: o.value, type: 'button', role: 'radio', 'aria-checked': on ? 'true' : 'false', className: on ? 'is-on' : '', onClick: function () { self.setView(o.value); } }, o.label);
            })),
            h(RM.Button, { icon: 'notebook', 'aria-pressed': s.exportMode ? 'true' : 'false', onClick: function () { self.openExport(); } }, 'Export notebook'),
            h(RM.Button, { iconOnly: true, icon: 'chevron-left', 'aria-label': 'Previous ' + unit, onClick: function () { self.step(-1); } }),
            h(RM.Button, { onClick: function () { self.goToday(); } }, 'Today'),
            h(RM.Button, { iconOnly: true, icon: 'chevron-right', 'aria-label': 'Next ' + unit, onClick: function () { self.step(1); } }),
            h('span', { className: 'rm-range' }, rangeText))),

        h('div', { className: 'rm-legend' },
          h('span', { className: 'rm-legend-lbl' }, 'Categories'),
          cats.map(function (c) {
            var on = s.catFilter === c.id;
            return h(RM.CategoryChip, { key: c.id, category: c, active: on, dimmed: !!s.catFilter && !on, onClick: function () { self.setState({ catFilter: on ? null : c.id }); } });
          }),
          h('div', { className: 'rm-newcat' },
            h('label', { htmlFor: 'rm-newcat', className: 'rm-sr' }, 'New category name'),
            h('input', {
              id: 'rm-newcat', className: 'rm-field', style: { width: 130 }, placeholder: 'New category', value: s.newCat,
              onChange: function (e) { self.setState({ newCat: e.target.value }); },
              onKeyDown: function (e) { if (e.key === 'Enter') { e.preventDefault(); self.addCat(); } }
            }),
            h(RM.Button, { size: 'sm', icon: 'plus', onClick: function () { self.addCat(); } }, 'Add')),
          view !== 'week' ? null : h('div', { className: 'rm-density' },
            h('span', { className: 'rm-legend-lbl' }, 'Day width'),
            h(Seg, {
              label: 'Day column width', value: density, onChange: function (d) { self.setDensity(d); },
              options: [{ value: 'compact', label: 'Compact' }, { value: 'comfortable', label: 'Default' }, { value: 'roomy', label: 'Roomy' }]
            }))),

        h('div', { className: 'rm-main' }, board, panel),
        renderPreview(this, ctx),

        s.toast ? h('div', { className: 'rm-toast', role: 'status' },
          h('span', null, s.toast.text),
          s.toast.undo ? h(RM.Button, { variant: 'inverse', onClick: function () { var u = s.toast.undo; self.setState({ toast: null }); u(); } }, 'Undo') : null,
          h(RM.Button, { variant: 'inverse', iconOnly: true, icon: 'x', 'aria-label': 'Dismiss', onClick: function () { self.setState({ toast: null }); } })) : null);
    }
  }

  ReactDOM.createRoot(document.getElementById('root')).render(h(App));
})();
