# Experiment Roadmap

A planning board for running many wet-lab experiments in parallel: one row per experiment, one column per day, steps crossed off as they happen, and any set of days exported as a lab notebook.

Built on the **Experiment Roadmap** design system (tokens, `bundle.css`, `window.Roadmap` components and `Roadmap.utils`), so it behaves like the prototype canvas.

## Files

| File | What it is |
|---|---|
| `index.html` | The page (published as a claude.ai artifact, which adds the document skeleton) |
| `app.js` | The app: storage, sync and the board, built from `Roadmap` components |
| `app.css` | Page layout around the components (header, legend, grid shell, toast) |
| `bundle.js`, `bundle.css` | Design-system components and styles, copied unchanged |
| `tokens.css` | Generated from `design-system/tokens.json` by `scripts/build-tokens.py` |

## Where your data lives

- **Your account (cloud).** Opened on claude.ai, the board is stored in the artifact's database under your own private folder (`data/users/<your id>/`). Nobody else, the artifact owner included, can read it. Every change saves right away and syncs live to your other open tabs and devices.
  - `meta`: experiments, categories and preferences (column widths, day width, export options)
  - `plans-YYYY-MM`: the steps planned in that month
  - `notes-YYYY-MM`: the daily notes for that month
- **This browser (cache).** A copy of your board and any unsent changes are kept in local storage, so the board opens instantly and edits made offline are sent when the connection returns.
- **Local only.** Opened as a plain file (outside claude.ai), the board is saved in that browser's local storage.

Deleting steps shows an **Undo** toast for 8 seconds.

## Additions beyond the prototype

- Persistence and sync as above, with a status line under the title ("Saved to your account", "Saving…", "Offline · 2 changes waiting to sync").
- **Download** in the notebook export.
- **Day width** presets (Compact / Default / Roomy), which also give keyboard users a way to change column width.
- Double-click an experiment's name to rename it.
- **Create an experiment without planning days.** Type a name in the New experiment row and press Create (or Enter) to get an empty row ("No steps yet"), then add steps with + on any day. Picking days first still works and also adds a "Plan step" on each picked day.
- New experiments don't ask for a category: their "Plan step" placeholders start with no category, and each step gets its own category when you edit it.
- Double-click a step to edit its text and category, or delete it.
- Copy steps to other days: select them and press Ctrl/⌘+C (or **Copy** in the selection bar), then point at a day and press Ctrl/⌘+V (or click **Paste** on that day). Steps copied from one experiment paste into the row you point at; the earliest lands on that day and the rest keep their spacing. Alt/Option-drag copies instead of moving.
- Delete selected steps with the Delete key or **Delete** in the selection bar. Delete an experiment with the × that appears when you hover over its name; it asks to confirm first.
- Every delete can be undone from the toast.
- Clicking empty space, or pressing Esc, clears picked days in the New experiment row and the step selection.
- **Endless timeline.** The grid scrolls sideways without end: weeks are added as you near either edge, and days far off the other side are dropped so the page stays fast. ◀ / ▶ jump a week, **Today** returns to this week, and the date range in the header shows what is on screen. The export panel offers the two weeks starting at the first Monday in view.
- **Repeating steps.** When adding or editing a step, choose how often it repeats (every day, every weekday, every 2 or 3 days, weekly, every 2 or 4 weeks, or every N days) and an end date. Each repeat is an ordinary step you tick off on its own; repeats share a series id, so the step editor can also change or delete all later repeats.
- **Timeline / Month / Year views** (segmented control in the header, after Apple Calendar; the choice is saved per person).
  - **Month:** a Monday-first grid with ISO week numbers. Each experiment is a multi-day bar from its first to last step, labelled with its protocol day (D0, D7…) at the start of each week. Steps appear as compact events (experiment dot, category tag, text), with "+N more steps", "!" for overdue, grey days when everything is done, and shaded weekends. Steps can be dragged to another day, selected, copied and pasted as in the timeline; clicking a day shows it in the daily note (or toggles it in export mode). ← / → change month.
  - **Contribution map** (top of the Year view, after GitHub): one square per day, weeks as columns and Monday–Sunday as rows. Three modes, remembered per person: **Completed** (steps ticked off, like commits), **Planned** (all scheduled steps, to spot crunch weeks ahead) and **By experiment** (each day painted in the color of the experiment with the most steps that day, deeper when busier, with an experiment legend). Shows the year's total, longest and current streak of days with completed steps, and the weekday you finish most on. Hover a square for its count and experiments; click it to open that month.
  - **Year:** twelve mini months shaded by steps per day, with orange dots on days that have overdue steps; click a day or month name to open that month. Above them, the year at a glance: steps planned and % done, experiments run, overdue steps, weekend bench days, busiest day and longest run. Below, **Experiment progress**: a Gantt bar per experiment across the year, with a tick per step (filled = done, ring = open, orange = overdue), a today line and done/total.
  - **Previews:** hover a step (or click it, which keeps the card open until you click elsewhere or press Esc) for a popover with its experiment, date and status (Today, In 3 days, Overdue · 2 days, Done), protocol day ("D7 · day 8 of 15"), its place in a repeat series, and the previous and next steps of the protocol, with Mark done, Show in timeline and Delete. Hover or click an experiment bar (or a Gantt row) for its span and duration, progress, next step, overdue count and category mix.
- **Pin an experiment** with the pin button that appears next to × when you hover its name (or Pin in its preview). A pinned experiment keeps its place among the running ones even when all its steps are done, instead of dropping under Completed; its row reads "All N steps done" and the pin stays visible. Unpin to let it drop down as usual. Stored as `pinned` on the experiment.
- **Reorder experiments** by dragging a running experiment's name cell up or down in the timeline (a grip shows on hover). Desk & meetings stays first; the order is saved to your account.
- **Daily note grouped by category.** Steps are listed under their category (TC, Cloning, …) in legend order, with steps of the same experiment together; the copyable summary uses the same grouping.
- Keyboard copy and paste match the physical C and V keys, so they also work with non-Latin keyboard layouts and input methods. Copied steps are also placed on the system clipboard as text.
