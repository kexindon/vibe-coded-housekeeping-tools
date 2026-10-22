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
  var KEEP_SELECTION = '.rm-plan, .rm-ghost, .rm-gname, .rm-selbar, .rm-toast, .rm-addform, .rm-cell-tool, .rm-resize, .rm-note, .rm-palette, button, input, select, textarea, label';

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

    // ---------- keyboard and clipboard ----------
    onKey(e) {
      var t = e.target, st = this.state;
      if (t && t.closest && t.closest('input, textarea, select, [contenteditable="true"]')) return;
      var mod = e.metaKey || e.ctrlKey;
      // Match the physical key too, so shortcuts work with any keyboard layout or input method.
      var isKey = function (ch) { return e.code === 'Key' + ch || (e.key || '').toUpperCase() === ch; };
      if (e.key === 'Escape') {
        this.setState({ sel: [], ghost: [], colorFor: null, confirmDel: null, adding: null });
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
    createExp() {
      var self = this, st = this.state, exps = st.data.exps;
      if (!st.ghost.length) return;
      var id = newId('x');
      var order = exps.reduce(function (m, e) { return Math.max(m, e.order || 0); }, 0) + 1;
      this.patchMeta('exps', id, { id: id, name: (st.ghostName || '').trim() || 'New experiment', color: U.nextExperimentColor(exps), order: order });
      st.ghost.forEach(function (d) { self.writePlan({ id: newId('p'), exp: id, date: d, text: 'Plan step', cat: 'none', done: false }, null); });
      this.setState({ ghost: [], ghostName: '' });
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
      var exportFrom = U.mondayOf(s.viewStart), exportDates = [];
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
      if (delta !== 0) plans.forEach(function (p) { if (selSet[p.id]) dropKeys[p.exp + '|' + U.shiftIso(p.date, delta)] = 1; });
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
          className: 'rm-expwrap', title: e.desk ? undefined : 'Double-click the name to rename',
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
        var meta = e.desk ? 'Analysis · slides · meetings' : (completed ? 'All ' + all.length + ' steps done' : nDone + ' of ' + all.length + ' steps done');
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
        return h('div', { key: e.id, className: 'rm-row' + (completed ? ' is-completed' : ''), style: rowStyle }, nameCell(e, completed, meta), cells);
      };

      var sorted = U.sortExperiments(exps, plans);
      var active = sorted.active, finished = sorted.completed;

      var ghostRow = h('div', { key: 'ghost', className: 'rm-row', style: rowStyle },
        h('div', { className: 'rm-gname' },
          h('div', { className: 'rm-gname-t' }, h(RM.Icon, { name: 'plus', size: 14, strokeWidth: 2.2 }), 'New experiment'),
          s.ghost.length === 0
            ? h('div', { className: 'rm-gname-s' }, 'Drag across days for a continuous run, or click separate days.')
            : [
              h('div', { key: 's', className: 'rm-gname-s' }, s.ghost.length + (s.ghost.length === 1 ? ' day: ' : ' days: ') + s.ghost.map(U.shortDate).join(', ')),
              h('input', {
                key: 'n', id: 'rm-ghostname', className: 'rm-field', placeholder: 'Experiment name', value: s.ghostName, 'aria-label': 'Experiment name',
                onChange: function (e) { self.setState({ ghostName: e.target.value }); },
                onKeyDown: function (e) { if (e.key === 'Enter') { e.preventDefault(); self.createExp(); } }
              }),
              h('div', { key: 'a', className: 'rm-gname-acts' },
                h(RM.Button, { size: 'sm', onClick: function () { self.setState({ ghost: [] }); } }, 'Clear'),
                h(RM.Button, { size: 'sm', variant: 'primary', onClick: function () { self.createExp(); } }, 'Create'))
            ]),
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
            : h('div', { className: 'rm-hint' },
              h('span', null, h('b', null, 'Drag'), ' a plan to move it'),
              h('span', null, h('b', null, MOD + 'C ' + MOD + 'V'), ' to copy'),
              h('span', null, h('b', null, 'Shift-click'), ' to select several'),
              h('span', null, h('b', null, 'Double-click'), ' to edit or delete')),
          h('div', { className: 'rm-nav' },
            h(RM.Button, { icon: 'notebook', 'aria-pressed': s.exportMode ? 'true' : 'false', onClick: function () { self.openExport(); } }, 'Export notebook'),
            h(RM.Button, { iconOnly: true, icon: 'chevron-left', 'aria-label': 'Previous week', onClick: function () { self.scrollToDate(U.mondayOf(U.shiftIso(s.viewStart, -1)), true); } }),
            h(RM.Button, { onClick: function () { self.setState({ focus: today }); self.scrollToDate(U.mondayOf(today), true); } }, 'Today'),
            h(RM.Button, { iconOnly: true, icon: 'chevron-right', 'aria-label': 'Next week', onClick: function () { self.scrollToDate(U.shiftIso(U.mondayOf(s.viewStart), 7), true); } }),
            h('span', { className: 'rm-range' }, MON[a0.getMonth()] + ' ' + a0.getDate() + ' – ' + MON[a1.getMonth()] + ' ' + a1.getDate() + ', ' + a1.getFullYear()))),

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
          h('div', { className: 'rm-density' },
            h('span', { className: 'rm-legend-lbl' }, 'Day width'),
            h(Seg, {
              label: 'Day column width', value: density, onChange: function (d) { self.setDensity(d); },
              options: [{ value: 'compact', label: 'Compact' }, { value: 'comfortable', label: 'Default' }, { value: 'roomy', label: 'Roomy' }]
            }))),

        h('div', { className: 'rm-main' },
          h('section', { className: 'rm-board', 'aria-label': 'Roadmap grid', onPointerLeave: function () { self.hoverCell = null; } },
            h('div', { className: 'rm-scroll', ref: function (el) { self.scrollEl = el; }, onScroll: function () { self.onScroll(); } }, h('div', { className: 'rm-grid' }, header, rows))),
          panel),

        s.toast ? h('div', { className: 'rm-toast', role: 'status' },
          h('span', null, s.toast.text),
          s.toast.undo ? h(RM.Button, { variant: 'inverse', onClick: function () { var u = s.toast.undo; self.setState({ toast: null }); u(); } }, 'Undo') : null,
          h(RM.Button, { variant: 'inverse', iconOnly: true, icon: 'x', 'aria-label': 'Dismiss', onClick: function () { self.setState({ toast: null }); } })) : null);
    }
  }

  ReactDOM.createRoot(document.getElementById('root')).render(h(App));
})();
