# File-size allowances for #4796 (admin page merges)

Two route pages gain a tab holding a page merged into them. The tab shell is
the shared `AdminPageTabs`, so each page adds only its default export naming
its tabs; the page's existing body stays where it was, renamed. Moving that
body to its own file would not shrink the debt: the gate follows a rename
only when the old path is deleted, so the body would be judged a new
over-budget file instead.

file: src/app/(admin)/admin/family-groups/page.tsx
lines: 881
reason: the default export now names the Groups and Suggestions tabs for the
  shared tab shell; the 860-line Groups body it wraps is the page this file
  already was, and a separate file for it would be new debt, not less.

file: src/app/(admin)/admin/membership-cancellations/page.tsx
lines: 1228
reason: the default export now names the Requests and Settings tabs for the
  shared tab shell; the queue body it wraps is the page this file already
  was, and a separate file for it would be new debt, not less.

file: src/lib/setup-readiness.ts
lines: 2287
reason: one import line, so the cancellation step links the Settings tab
  through the hub registry instead of a hand-written URL (INV-SSOT); there is
  no smaller way to name the link.

file: src/lib/admin-permissions.ts
lines: 949
reason: the matrix form of the admission rule (`canOpenAdminPathWithMatrix`,
  which hub cards and setup links now use) has to be the same body as
  `canOpenAdminPath`, which now calls it; putting it in another module would
  split one authorization rule across two files.
