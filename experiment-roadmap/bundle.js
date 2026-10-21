/* @ds-bundle: {"format":4,"namespace":"Roadmap","components":[{"name":"Icon"},{"name":"Button"},{"name":"CategoryTag"},{"name":"CategoryChip"},{"name":"Checkbox"},{"name":"PlanItem"},{"name":"PlanCard"},{"name":"DayCell"},{"name":"DayHeader"},{"name":"ResizeHandle"},{"name":"ExperimentLabel"},{"name":"SwatchPicker"},{"name":"GhostCell"},{"name":"SelectionBar"},{"name":"ProgressBar"},{"name":"DailyNote"},{"name":"NotebookExport"}]} */
(function () {
  var R = window.React;
  var h = R.createElement;

  // ---------- data ----------
  var CATEGORIES = [
    { id: 'tc', name: 'TC', tag: 'TC', color: 'var(--cat-tc)', group: 'bench' },
    { id: 'clone', name: 'Cloning', tag: 'CL', color: 'var(--cat-clone)', group: 'bench' },
    { id: 'mouse', name: 'Mouse work', tag: 'MS', color: 'var(--cat-mouse)', group: 'bench' },
    { id: 'flow', name: 'Flow', tag: 'FL', color: 'var(--cat-flow)', group: 'bench' },
    { id: 'sort', name: 'Sorting', tag: 'SO', color: 'var(--cat-sort)', group: 'bench' },
    { id: 'analysis', name: 'Analysis', tag: 'AN', color: 'var(--cat-analysis)', group: 'analysis' },
    { id: 'slides', name: 'Slides', tag: 'SL', color: 'var(--cat-slides)', group: 'slides' },
    { id: 'meeting', name: 'Meeting', tag: 'MT', color: 'var(--cat-meeting)', group: 'meeting' }
  ];
  var CUSTOM_CATEGORY_COLORS = ['var(--cat-custom-1)', 'var(--cat-custom-2)', 'var(--cat-custom-3)', 'var(--cat-custom-4)', 'var(--cat-custom-5)', 'var(--cat-custom-6)'];
  // Google Docs presets: "light 1" row then "dark 1" row
  var EXPERIMENT_COLORS = [
    { name: 'Red', hex: '#E06666' }, { name: 'Orange', hex: '#F6B26B' }, { name: 'Yellow', hex: '#FFD966' }, { name: 'Green', hex: '#93C47D' },
    { name: 'Cyan', hex: '#76A5AF' }, { name: 'Blue', hex: '#6FA8DC' }, { name: 'Purple', hex: '#8E7CC3' }, { name: 'Magenta', hex: '#C27BA0' },
    { name: 'Deep red', hex: '#CC0000' }, { name: 'Deep orange', hex: '#E69138' }, { name: 'Deep yellow', hex: '#F1C232' }, { name: 'Deep green', hex: '#6AA84F' },
    { name: 'Deep cyan', hex: '#45818E' }, { name: 'Deep blue', hex: '#3D85C6' }, { name: 'Deep purple', hex: '#674EA7' }, { name: 'Deep magenta', hex: '#A64D79' }
  ];
  var DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // ---------- utils (pure; safe on a server too) ----------
  function fromIso(s) { var p = s.split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function iso(d) { var m = d.getMonth() + 1, dd = d.getDate(); return d.getFullYear() + '-' + (m < 10 ? '0' : '') + m + '-' + (dd < 10 ? '0' : '') + dd; }
  function shiftIso(s, n) { var d = fromIso(s); return iso(new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)); }
  function dayDiff(a, b) { return Math.round((fromIso(b) - fromIso(a)) / 86400000); }
  function isoWeek(d) {
    var t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    var wd = t.getUTCDay() || 7;
    t.setUTCDate(t.getUTCDate() + 4 - wd);
    var y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
    return Math.ceil(((t - y0) / 86400000 + 1) / 7);
  }
  function mondayOf(s) { var d = fromIso(s); var wd = d.getDay() || 7; return shiftIso(s, 1 - wd); }
  function shortDate(s) { var d = fromIso(s); return MON[d.getMonth()] + ' ' + d.getDate(); }
  function longDate(s) { var d = fromIso(s); return DOW[d.getDay()] + ', ' + MON[d.getMonth()] + ' ' + d.getDate() + ' ' + d.getFullYear(); }
  function laneBackground(hex) { return 'color-mix(in srgb, ' + hex + ' 16%, var(--bg-surface))'; }
  function categoryMap(cats) { var m = {}; (cats || CATEGORIES).forEach(function (c) { m[c.id] = c; }); return m; }
  function isDayDone(plans, date) {
    var any = false;
    for (var i = 0; i < plans.length; i++) { var p = plans[i]; if (p.date !== date) continue; any = true; if (!p.done) return false; }
    return any;
  }
  function isExperimentComplete(exp, plans) {
    if (exp.desk) return false;
    var any = false;
    for (var i = 0; i < plans.length; i++) { var p = plans[i]; if (p.exp !== exp.id) continue; any = true; if (!p.done) return false; }
    return any;
  }
  // Desk row first, then running experiments in their saved order, then completed ones.
  function sortExperiments(exps, plans) {
    var active = [], done = [];
    exps.forEach(function (e) { (isExperimentComplete(e, plans) ? done : active).push(e); });
    active.sort(function (a, b) { return (b.desk ? 1 : 0) - (a.desk ? 1 : 0); });
    return { active: active, completed: done };
  }
  function shiftPlans(plans, ids, n) {
    var sel = {}; ids.forEach(function (id) { sel[id] = 1; });
    return plans.map(function (p) { return sel[p.id] ? Object.assign({}, p, { date: shiftIso(p.date, n) }) : p; });
  }
  function nextExperimentColor(exps) {
    var used = exps.map(function (e) { return e.color; });
    for (var i = 0; i < 8; i++) if (used.indexOf(EXPERIMENT_COLORS[i].hex) < 0) return EXPERIMENT_COLORS[i].hex;
    return EXPERIMENT_COLORS[exps.length % 16].hex;
  }

  // Daily summary: plans of one day grouped Bench / Analysis / Slides / Meetings, plus plain text.
  function buildDailySummary(o) {
    var cm = categoryMap(o.cats), em = {};
    o.exps.forEach(function (e) { em[e.id] = e; });
    var day = o.plans.filter(function (p) { return p.date === o.date; });
    var defs = [['bench', 'Bench work'], ['analysis', 'Analysis'], ['slides', 'Slides'], ['meeting', 'Meetings']];
    var lines = [longDate(o.date)];
    var sections = defs.map(function (d) {
      var items = day.filter(function (p) { var c = cm[p.cat]; return (c && c.group ? c.group : 'bench') === d[0]; });
      if (items.length) lines.push('', d[1].toUpperCase());
      items.forEach(function (p) {
        var e = em[p.exp] || {}, c = cm[p.cat] || { tag: '··' };
        lines.push((p.done ? '[x] ' : '[ ] ') + p.text + (e.desk ? '' : ' — ' + (e.name || '')) + ' (' + c.tag + ')');
      });
      return { id: d[0], title: d[1], items: items };
    });
    var note = ((o.notes || {})[o.date] || '').trim();
    if (note) lines.push('', 'NOTES', note);
    return { sections: sections, done: day.filter(function (p) { return p.done; }).length, total: day.length, text: lines.join('\n') };
  }

  // Lab-notebook export of selected days.
  // o: { days, plans, exps, cats, notes, group: 'day'|'experiment', format: 'md'|'text', includeOpen, includeNotes, includeDesk }
  function buildNotebook(o) {
    var md = o.format !== 'text';
    var days = o.days.slice().sort();
    var cm = categoryMap(o.cats);
    var em = {}, ei = {};
    o.exps.forEach(function (e, i) { em[e.id] = e; ei[e.id] = i; });
    var first = {};
    o.plans.forEach(function (p) { if (!first[p.exp] || p.date < first[p.exp]) first[p.exp] = p.date; });
    var ds = {}; days.forEach(function (d) { ds[d] = 1; });
    var ps = o.plans.filter(function (p) {
      var e = em[p.exp];
      if (!e || !ds[p.date]) return false;
      if (!o.includeOpen && !p.done) return false;
      if (e.desk && !o.includeDesk) return false;
      return true;
    }).sort(function (a, b) { return (ei[a.exp] - ei[b.exp]) || (a.date < b.date ? -1 : a.date > b.date ? 1 : 0); });
    var item = function (p) {
      var c = cm[p.cat] || { name: p.cat };
      var box = '[' + (p.done ? 'x' : ' ') + '] ';
      return md ? '- ' + box + p.text + ' _(' + c.name + ')_' : '    ' + box + p.text + ' (' + c.name + ')';
    };
    var offset = function (e, d) { return e.desk || !first[e.id] ? '' : ' · D' + dayDiff(first[e.id], d); };
    var noteOf = function (d) { return o.includeNotes ? ((o.notes || {})[d] || '').trim() : ''; };
    var noteLines = function (t) { return t.split('\n').map(function (l) { return md ? '> ' + l : '    ' + l; }); };
    var hd = function (level, t) { return md ? new Array(level + 1).join('#') + ' ' + t : t; };
    var rule = function (t) { return md ? [] : [new Array(Math.min(t.length, 48) + 1).join('-')]; };
    var out = [];
    var range = !days.length ? 'no days selected'
      : days.length === 1 ? longDate(days[0])
      : shortDate(days[0]) + ' – ' + shortDate(days[days.length - 1]) + ', ' + fromIso(days[days.length - 1]).getFullYear();
    var head = 'Lab notebook · ' + range;
    var sub = days.length + (days.length === 1 ? ' day' : ' days') + ', exported from Experiment roadmap';
    out.push(md ? '# ' + head : head.toUpperCase());
    if (!md) out.push(new Array(head.length + 1).join('='));
    out.push(md ? '_' + sub + '_' : sub);
    var wrote = false;
    if (o.group === 'experiment') {
      var by = {}, order = [];
      ps.forEach(function (p) { if (!by[p.exp]) { by[p.exp] = []; order.push(p.exp); } by[p.exp].push(p); });
      order.forEach(function (id) {
        var e = em[id], cur = null;
        out.push('', hd(2, e.name)); out.push.apply(out, rule(e.name));
        by[id].forEach(function (p) {
          if (p.date !== cur) { cur = p.date; out.push('', hd(3, longDate(p.date) + offset(e, p.date))); }
          out.push(item(p));
        });
        wrote = true;
      });
      var nd = days.filter(function (d) { return noteOf(d); });
      if (nd.length) {
        out.push('', hd(2, 'Daily notes')); out.push.apply(out, rule('Daily notes'));
        nd.forEach(function (d) { out.push('', hd(3, longDate(d))); out.push.apply(out, noteLines(noteOf(d))); });
        wrote = true;
      }
    } else {
      days.forEach(function (d) {
        var dp = ps.filter(function (p) { return p.date === d; }), nt = noteOf(d), cur = null;
        if (!dp.length && !nt) return;
        out.push('', hd(2, longDate(d))); out.push.apply(out, rule(longDate(d)));
        dp.forEach(function (p) {
          if (p.exp !== cur) { cur = p.exp; out.push('', hd(3, em[p.exp].name + offset(em[p.exp], d))); }
          out.push(item(p));
        });
        if (nt) { out.push('', md ? '**Notes**' : 'Notes:'); out.push.apply(out, noteLines(nt)); }
        wrote = true;
      });
    }
    if (!wrote) out.push('', md ? '_Nothing recorded for the selected days._' : 'Nothing recorded for the selected days.');
    return out.join('\n');
  }
  function notebookFilename(days, format) {
    var d = days.slice().sort();
    var span = d.length ? (d.length === 1 ? d[0] : d[0] + '_to_' + d[d.length - 1]) : 'empty';
    return 'lab-notebook_' + span + (format === 'text' ? '.txt' : '.md');
  }
  // Column widths: one shared day width and a separate name width, both user-resizable.
  var COLUMN_LIMITS = { day: { min: 120, max: 360, initial: 200 }, name: { min: 200, max: 420, initial: 264 } };
  function clampWidth(kind, w) { var l = COLUMN_LIMITS[kind]; return Math.round(Math.max(l.min, Math.min(l.max, w))); }
  // Call from a handle's onPointerDown. Tracks the pointer on window until release.
  // opts: { kind: 'day'|'name', startWidth, onChange(width), onEnd(width) }
  function startColumnResize(e, opts) {
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    var x0 = e.clientX, w = opts.startWidth;
    document.documentElement.classList.add('rm-resizing');
    function move(ev) { w = clampWidth(opts.kind, opts.startWidth + ev.clientX - x0); opts.onChange && opts.onChange(w); }
    function up() {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      document.documentElement.classList.remove('rm-resizing');
      opts.onEnd && opts.onEnd(w);
    }
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }
  // Remembered per viewer; storage can be unavailable, so every access is guarded.
  function loadColumnWidths(key) {
    try { var v = JSON.parse(window.localStorage.getItem(key || 'roadmap.columns') || 'null'); if (v) return { day: clampWidth('day', v.day || 200), name: clampWidth('name', v.name || 264) }; } catch (e) {}
    return { day: COLUMN_LIMITS.day.initial, name: COLUMN_LIMITS.name.initial };
  }
  function saveColumnWidths(widths, key) { try { window.localStorage.setItem(key || 'roadmap.columns', JSON.stringify(widths)); } catch (e) {} }

  // Browser download for the deployed app (not available inside sandboxed previews).
  function downloadText(filename, text, mime) {
    var blob = new Blob([text], { type: (mime || 'text/markdown') + ';charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  // ---------- helpers ----------
  function cx() { var a = []; for (var i = 0; i < arguments.length; i++) if (arguments[i]) a.push(arguments[i]); return a.join(' '); }
  function stop(e) { e.stopPropagation(); }

  // ---------- components ----------
  var ICONS = {
    flask: [['path', { d: 'M9 3h6' }], ['path', { d: 'M10 3v6.5L4.6 18.2A2 2 0 0 0 6.3 21h11.4a2 2 0 0 0 1.7-2.8L14 9.5V3' }], ['path', { d: 'M7.5 15h9' }]],
    'chevron-left': [['path', { d: 'M15 18l-6-6 6-6' }]],
    'chevron-right': [['path', { d: 'M9 18l6-6-6-6' }]],
    plus: [['path', { d: 'M12 5v14M5 12h14' }]],
    x: [['path', { d: 'M18 6L6 18M6 6l12 12' }]],
    check: [['path', { d: 'M5 12.5l4.5 4.5L19 7' }]],
    copy: [['rect', { x: 9, y: 9, width: 12, height: 12, rx: 2 }], ['path', { d: 'M5 15V5a2 2 0 0 1 2-2h10' }]],
    monitor: [['rect', { x: 3, y: 4, width: 18, height: 12, rx: 2 }], ['path', { d: 'M8 20h8M12 16v4' }]],
    notebook: [['path', { d: 'M4 19.5V5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2' }], ['path', { d: 'M19 17v4H6' }], ['path', { d: 'M9 7h6M9 11h4' }]],
    download: [['path', { d: 'M12 4v11' }], ['path', { d: 'M7 10l5 5 5-5' }], ['path', { d: 'M5 20h14' }]]
  };
  function Icon(props) {
    var parts = ICONS[props.name] || [];
    var size = props.size || 16;
    return h('svg', {
      className: cx('rm-icon', props.className), width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
      stroke: props.color || 'currentColor', strokeWidth: props.strokeWidth || 2, strokeLinecap: 'round', strokeLinejoin: 'round',
      'aria-hidden': props.label ? undefined : 'true', role: props.label ? 'img' : undefined, 'aria-label': props.label
    }, parts.map(function (p, i) { return h(p[0], Object.assign({ key: i }, p[1])); }));
  }

  function Button(props) {
    var variant = props.variant || 'default', size = props.size || 'md';
    var rest = Object.assign({}, props);
    delete rest.variant; delete rest.size; delete rest.icon; delete rest.iconOnly; delete rest.children; delete rest.className;
    return h('button', Object.assign({ type: 'button' }, rest, {
      className: cx('rm-btn', size === 'sm' && 'rm-btn-sm', variant !== 'default' && 'rm-btn-' + variant, props.iconOnly && 'rm-btn-icon', props.className)
    }), props.icon ? h(Icon, { name: props.icon, size: size === 'sm' ? 13 : 15 }) : null, props.iconOnly ? null : props.children);
  }

  function CategoryTag(props) {
    var c = props.category || {};
    return h('span', { className: 'rm-tag', style: { color: props.done ? 'var(--done-ink)' : c.color }, title: c.name }, c.tag);
  }

  function CategoryChip(props) {
    var c = props.category;
    return h('button', {
      type: 'button', className: cx('rm-chip', props.active && 'is-active', props.dimmed && 'is-dimmed'),
      'aria-pressed': props.active ? 'true' : 'false', onClick: props.onClick
    }, h('span', { className: 'rm-tag', style: { color: c.color } }, c.tag), h('span', { style: { color: c.color } }, c.name));
  }

  function Checkbox(props) {
    return h('button', {
      type: 'button', className: cx('rm-check', props.checked && 'is-on'), style: { color: props.color || 'var(--ink)' },
      role: 'checkbox', 'aria-checked': props.checked ? 'true' : 'false', 'aria-label': props.label,
      onClick: props.onChange, onPointerDown: stop
    }, h(Icon, { name: 'check', size: 10, strokeWidth: 4, color: 'var(--inverse-ink)' }));
  }

  function PlanItem(props) {
    var c = props.category || { tag: '··', color: 'var(--muted)', name: 'Uncategorized' };
    var color = props.done ? 'var(--done-ink)' : c.color;
    var text = props.editing
      ? h('input', {
        className: 'rm-plan-input', autoFocus: true, defaultValue: props.text, 'aria-label': 'Rename plan', onPointerDown: stop,
        onKeyDown: function (e) { if (e.key === 'Enter') props.onRename && props.onRename(e.currentTarget.value); else if (e.key === 'Escape') props.onCancelRename && props.onCancelRename(); },
        onBlur: function (e) { props.onRename && props.onRename(e.currentTarget.value); }
      })
      : h('span', { className: 'rm-plan-text', style: { color: color } }, props.text);
    return h('div', {
      className: cx('rm-plan', props.done && 'is-done', props.selected && 'is-selected', props.dimmed && 'is-dimmed'),
      title: c.name + (props.done ? ' · done' : ''),
      onPointerDown: props.onPointerDown, onDoubleClick: props.onDoubleClick
    },
      h(Checkbox, { checked: !!props.done, color: color, label: (props.done ? 'Mark not done: ' : 'Mark done: ') + props.text, onChange: props.onToggle }),
      h('span', { className: 'rm-tag', style: { color: color } }, c.tag),
      text);
  }

  function PlanCard(props) {
    return h('div', { className: cx('rm-card', props.allDone && 'is-done') },
      props.dayOffset != null ? h('div', { className: 'rm-offset' }, 'D' + props.dayOffset) : null,
      props.children);
  }

  function DayCell(props) {
    return h('div', {
      className: cx('rm-cell', props.today && 'is-today', props.dayDone && 'is-day-done', props.dropTarget && 'is-drop'),
      style: props.laneColor ? { background: laneBackground(props.laneColor) } : undefined,
      onPointerEnter: props.onPointerEnter
    },
      props.children,
      props.onAdd ? h('button', { type: 'button', className: 'rm-add', 'aria-label': props.addLabel || 'Add a step', onPointerDown: stop, onClick: props.onAdd }, h(Icon, { name: 'plus', size: 13, strokeWidth: 2.4 })) : null);
  }

  function DayHeader(props) {
    var d = fromIso(props.date), wd = d.getDay();
    return h('button', {
      type: 'button',
      className: cx('rm-dayhead', (wd === 0 || wd === 6) && 'is-weekend', props.allDone && 'is-done', props.today && 'is-today', props.focused && 'is-focused', props.exportSelected && 'is-export'),
      'aria-pressed': props.exportSelected != null ? (props.exportSelected ? 'true' : 'false') : undefined,
      onClick: props.onClick, onPointerEnter: props.onPointerEnter
    },
      h('span', { className: 'rm-dayhead-num' }, d.getDate()),
      h('span', { className: 'rm-dayhead-dow' }, DOW[wd]),
      h('span', { className: 'rm-dayhead-stat' }, props.exportSelected ? 'export' : (props.stat != null ? props.stat : '')),
      props.onResizeStart ? h(ResizeHandle, { inButton: true, label: 'Day column width', value: props.width, onResizeStart: props.onResizeStart, onReset: props.onResizeReset, onNudge: props.onResizeNudge }) : null);
  }

  // Vertical drag handle on a column's right edge. Pointer drag via onResizeStart (use utils.startColumnResize),
  // double-click resets, Arrow keys nudge by 8px. Inside a <button> header it renders as a span so markup stays valid.
  function ResizeHandle(props) {
    var common = {
      className: 'rm-resize',
      title: 'Drag to resize · double-click to reset',
      onPointerDown: props.onResizeStart,
      onClick: stop,
      onDoubleClick: function (e) { e.stopPropagation(); props.onReset && props.onReset(); }
    };
    if (props.inButton) return h('span', Object.assign({ 'aria-hidden': 'true' }, common));
    return h('div', Object.assign({
      role: 'separator', 'aria-orientation': 'vertical', 'aria-label': props.label || 'Column width', tabIndex: 0,
      'aria-valuenow': props.value,
      onKeyDown: function (e) {
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); props.onNudge && props.onNudge(e.key === 'ArrowLeft' ? -8 : 8); }
        else if (e.key === 'Enter' && props.onReset) { e.preventDefault(); props.onReset(); }
      }
    }, common));
  }

  function SwatchPicker(props) {
    var colors = props.colors || EXPERIMENT_COLORS;
    return h('div', { className: 'rm-palette', role: 'group', 'aria-label': 'Experiment color' },
      h('span', { className: 'rm-palette-label' }, props.label || 'Google Docs presets'),
      colors.map(function (c) {
        return h('button', {
          key: c.hex, type: 'button', className: cx('rm-palette-sw', c.hex === props.value && 'is-on'),
          style: { background: c.hex }, 'aria-label': c.name, 'aria-pressed': c.hex === props.value ? 'true' : 'false',
          onClick: function () { props.onChange && props.onChange(c.hex); }
        });
      }));
  }

  function ExperimentLabel(props) {
    var mark = props.desk
      ? h('span', { className: 'rm-deskmark', 'aria-hidden': 'true' }, h(Icon, { name: 'monitor', size: 12, strokeWidth: 2.2 }))
      : h('button', { type: 'button', className: 'rm-swatch', style: { background: props.color }, 'aria-label': 'Change color of ' + props.name, 'aria-expanded': props.paletteOpen ? 'true' : 'false', onClick: props.onColorClick });
    return h('div', { className: cx('rm-exp', props.completed && 'is-completed') },
      h('div', { className: 'rm-exp-row' }, mark,
        h('div', null, h('div', { className: 'rm-exp-name' }, props.name), props.meta ? h('div', { className: 'rm-exp-meta' }, props.meta) : null)),
      props.paletteOpen ? h(SwatchPicker, { value: props.color, onChange: props.onColorChange }) : null);
  }

  function GhostCell(props) {
    return h('div', {
      className: cx('rm-ghost', props.selected && 'is-selected'), role: 'button', tabIndex: 0,
      'aria-pressed': props.selected ? 'true' : 'false', 'aria-label': props.label || 'Select day for a new experiment',
      onPointerDown: props.onPointerDown, onPointerEnter: props.onPointerEnter,
      onKeyDown: function (e) { if ((e.key === 'Enter' || e.key === ' ') && props.onToggle) { e.preventDefault(); props.onToggle(); } }
    });
  }

  function SelectionBar(props) {
    var n = props.count || 0;
    return h('div', { className: 'rm-selbar', role: 'toolbar', 'aria-label': 'Selected plans' },
      h('span', null, n + (n === 1 ? ' plan selected' : ' plans selected')),
      h(Button, { variant: 'inverse', icon: 'chevron-left', onClick: props.onEarlier }, '1 day earlier'),
      h(Button, { variant: 'inverse', onClick: props.onLater }, '1 day later', h(Icon, { name: 'chevron-right', size: 14 })),
      h(Button, { variant: 'inverse', onClick: props.onDone }, 'Mark done'),
      h(Button, { variant: 'inverse', onClick: props.onDelete }, 'Delete'),
      h(Button, { variant: 'inverse', iconOnly: true, icon: 'x', 'aria-label': 'Clear selection', onClick: props.onClear }));
  }

  function ProgressBar(props) {
    var pct = props.total ? Math.round(100 * props.done / props.total) : 0;
    return h('div', { className: 'rm-progress' },
      h('div', { className: 'rm-progress-track', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': props.total || 0, 'aria-valuenow': props.done || 0 },
        h('div', { className: 'rm-progress-fill', style: { width: pct + '%' } })),
      h('span', null, props.total ? props.done + ' of ' + props.total + ' done' : 'No plans'));
  }

  function DailyNote(props) {
    var cm = categoryMap(props.categories);
    var sections = (props.sections || []).filter(function (s) { return s.items.length; });
    return h('aside', { className: 'rm-note rm-root', 'aria-label': 'Daily note' },
      h('div', { className: 'rm-note-head' },
        h('div', null, h('div', { className: 'rm-eyebrow' }, 'Daily note'), h('h2', { className: 'rm-note-title' }, props.dateLabel)),
        h('div', { style: { display: 'flex', gap: 6 } },
          h(Button, { iconOnly: true, icon: 'chevron-left', 'aria-label': 'Previous day', onClick: props.onPrev }),
          h(Button, { iconOnly: true, icon: 'chevron-right', 'aria-label': 'Next day', onClick: props.onNext }))),
      h(ProgressBar, { done: props.done, total: props.total }),
      sections.map(function (s) {
        var nd = s.items.filter(function (p) { return p.done; }).length;
        return h('div', { key: s.id || s.title, className: 'rm-note-sec' },
          h('h3', null, s.title, ' ', h('span', null, nd + '/' + s.items.length)),
          s.items.map(function (p) {
            var c = cm[p.cat] || { tag: '··', color: 'var(--muted)' };
            var color = p.done ? 'var(--done-ink)' : c.color;
            return h('div', { key: p.id, className: cx('rm-note-item', p.done && 'is-done') },
              h(Checkbox, { checked: !!p.done, color: color, label: (p.done ? 'Mark not done: ' : 'Mark done: ') + p.text, onChange: function () { props.onToggle && props.onToggle(p.id); } }),
              h('div', { style: { flex: 1, minWidth: 0 } },
                h('div', null, h('span', { className: 'rm-tag', style: { color: color } }, c.tag), ' ', h('span', { className: 'rm-note-text', style: { color: color } }, p.text)),
                p.experimentName ? h('div', { className: 'rm-note-exp' }, h('i', { style: { background: p.experimentColor } }), p.experimentName) : null));
          }));
      }),
      sections.length ? null : h('div', { className: 'rm-note-empty' }, 'Nothing planned for this day.'),
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
        h('label', { htmlFor: props.notesId || 'rm-daynote' }, 'Notes for the day'),
        h('textarea', { id: props.notesId || 'rm-daynote', value: props.notes || '', placeholder: 'Observations, reagent lots, what to change tomorrow…', onChange: function (e) { props.onNotesChange && props.onNotesChange(e.target.value); } })),
      props.summary != null ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
        h('div', { className: 'rm-note-row' }, h('span', { className: 'rm-eyebrow' }, 'Summary'),
          h(Button, { size: 'sm', icon: 'copy', onClick: props.onCopy }, props.copied ? 'Copied' : 'Copy note')),
        h('div', { className: 'rm-note-compiled' }, props.summary)) : null);
  }

  function Seg(props) {
    return h('div', { className: 'rm-seg', role: 'radiogroup', 'aria-label': props.label },
      props.options.map(function (o) {
        var on = o.value === props.value;
        return h('button', { key: o.value, type: 'button', role: 'radio', 'aria-checked': on ? 'true' : 'false', className: on ? 'is-on' : '', onClick: function () { props.onChange && props.onChange(o.value); } }, o.label);
      }));
  }

  function NotebookExport(props) {
    var n = (props.days || []).filter(function (d) { return d.selected; }).length;
    var opt = function (key, label) {
      var id = 'rm-x-' + key;
      return h('label', { className: 'rm-opt', htmlFor: id, key: key },
        h('input', { id: id, type: 'checkbox', checked: !!props[key], onChange: function (e) { props.onOptionChange && props.onOptionChange(key, e.target.checked); } }), ' ', label);
    };
    return h('aside', { className: 'rm-note rm-root', 'aria-label': 'Export lab notebook' },
      h('div', { className: 'rm-note-head' },
        h('div', null, h('div', { className: 'rm-eyebrow' }, 'Export'), h('h2', { className: 'rm-note-title' }, 'Lab notebook')),
        props.onClose ? h(Button, { iconOnly: true, icon: 'x', 'aria-label': 'Close export', onClick: props.onClose }) : null),
      h('div', { className: 'rm-xhint' }, 'Pick the days to export. Click day headers in the grid, the days below, or a preset.'),
      props.presets && props.presets.length ? h('div', { className: 'rm-xpresets' }, props.presets.map(function (p) { return h(Button, { key: p.label, size: 'sm', onClick: p.onClick }, p.label); })) : null,
      h('div', { className: 'rm-xdays' }, (props.days || []).map(function (d) {
        var dt = fromIso(d.date);
        return h('button', {
          key: d.date, type: 'button', className: cx('rm-xday', d.selected && 'is-on', !d.hasContent && 'is-empty'),
          'aria-pressed': d.selected ? 'true' : 'false', 'aria-label': DOW[dt.getDay()] + ' ' + shortDate(d.date) + (d.hasContent ? '' : ', nothing planned'),
          onClick: function () { props.onToggleDay && props.onToggleDay(d.date); }
        }, h('span', { className: 'rm-xday-dow' }, DOW[dt.getDay()]), h('span', { className: 'rm-xday-num' }, dt.getDate()));
      })),
      h('fieldset', { className: 'rm-xfs' }, h('legend', null, 'Organize by'),
        h(Seg, { label: 'Organize by', value: props.group || 'day', onChange: props.onGroupChange, options: [{ value: 'day', label: 'Day, then experiment' }, { value: 'experiment', label: 'Experiment, then day' }] })),
      h('fieldset', { className: 'rm-xfs' }, h('legend', null, 'Format'),
        h(Seg, { label: 'Format', value: props.format || 'md', onChange: props.onFormatChange, options: [{ value: 'md', label: 'Markdown' }, { value: 'text', label: 'Plain text' }] })),
      h('fieldset', { className: 'rm-xfs' }, h('legend', null, 'Include'),
        opt('includeOpen', 'Unfinished steps'), opt('includeNotes', 'Daily notes'), opt('includeDesk', 'Desk & meetings')),
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
        h('div', { className: 'rm-note-row' },
          h('span', { className: 'rm-eyebrow' }, 'Preview · ' + n + (n === 1 ? ' day' : ' days')),
          h('div', { style: { display: 'flex', gap: 6 } },
            props.onDownload ? h(Button, { size: 'sm', icon: 'download', onClick: props.onDownload }, 'Download') : null,
            h(Button, { size: 'sm', variant: 'primary', icon: 'copy', onClick: props.onCopy }, props.copied ? 'Copied' : 'Copy notebook'))),
        h('div', { className: 'rm-note-compiled', style: { maxHeight: 380 } }, props.preview || '')));
  }

  var api = {
    Icon: Icon, Button: Button, CategoryTag: CategoryTag, CategoryChip: CategoryChip, Checkbox: Checkbox,
    PlanItem: PlanItem, PlanCard: PlanCard, DayCell: DayCell, DayHeader: DayHeader, ResizeHandle: ResizeHandle, ExperimentLabel: ExperimentLabel,
    SwatchPicker: SwatchPicker, GhostCell: GhostCell, SelectionBar: SelectionBar, ProgressBar: ProgressBar,
    DailyNote: DailyNote, NotebookExport: NotebookExport,
    CATEGORIES: CATEGORIES, CUSTOM_CATEGORY_COLORS: CUSTOM_CATEGORY_COLORS, EXPERIMENT_COLORS: EXPERIMENT_COLORS,
    utils: {
      fromIso: fromIso, iso: iso, shiftIso: shiftIso, dayDiff: dayDiff, isoWeek: isoWeek, mondayOf: mondayOf,
      shortDate: shortDate, longDate: longDate, laneBackground: laneBackground, categoryMap: categoryMap,
      isDayDone: isDayDone, isExperimentComplete: isExperimentComplete, sortExperiments: sortExperiments,
      shiftPlans: shiftPlans, nextExperimentColor: nextExperimentColor,
      buildDailySummary: buildDailySummary, buildNotebook: buildNotebook, notebookFilename: notebookFilename, downloadText: downloadText,
      COLUMN_LIMITS: COLUMN_LIMITS, clampWidth: clampWidth, startColumnResize: startColumnResize,
      loadColumnWidths: loadColumnWidths, saveColumnWidths: saveColumnWidths
    }
  };
  window.Roadmap = Object.assign(window.Roadmap || {}, api);
})();
