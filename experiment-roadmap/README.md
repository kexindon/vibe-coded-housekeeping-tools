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
- New experiments don't ask for a category: their "Plan step" placeholders start with no category, and each step gets its own category when you edit it.
- Double-click a step to edit its text and category, or delete it.
- Copy steps to other days: select them and press Ctrl/⌘+C (or **Copy** in the selection bar), then point at a day and press Ctrl/⌘+V (or click **Paste** on that day). Steps copied from one experiment paste into the row you point at; the earliest lands on that day and the rest keep their spacing. Alt/Option-drag copies instead of moving.
- Delete selected steps with the Delete key or **Delete** in the selection bar. Delete an experiment with the × that appears when you hover over its name; it asks to confirm first.
- Every delete can be undone from the toast.
- Clicking empty space, or pressing Esc, clears picked days in the New experiment row and the step selection.
