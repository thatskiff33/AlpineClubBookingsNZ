# File-size allowances for #2975 / #2984

## `src/lib/admin-permissions.ts`

The privilege-model change itself is a one-line condition. What grew the file is
the explanation of it, and then the removal of a duplicate.

`hasAdminPortalAccess` used to exclude `finance`, and that exclusion had already
been read three separate ways by three separate pieces of work — as a deliberate
boundary (`admin-lodges-access-gate.test.ts`), as a shipped preset's known defect
(#2925), and as an outright contradiction with `getFirstAccessibleAdminHref`
twenty lines below it. A reader who does not know which of those was true will
re-litigate it, so the docblock says what standing is, what it is NOT, which
callers may ask the question, and where the negative half is proved.

The rest is `canOpenAdminPath`: "may this person open this admin path", which was
written out by hand in four places across the tree, with the consolidated fee
console's OR rule spelled two different ways between them. Giving it one home
ADDS lines here and REMOVES more from `admin-layout-guard.ts` and
`src/app/api/help/chat/route.ts`, which is the trade this repository's
single-source-of-truth rule asks for.

Splitting is available in principle — the route map, the matrix resolution and
the derived-access helpers are three separable concerns — but it is a refactor of
a security-critical module with about eighty importers, and doing it underneath a
privilege-model correction would put the change and the move in one diff and make
the diff unreviewable. Left as a debt to pay on its own change.

file: src/lib/admin-permissions.ts
lines: 888
reason: the privilege-model correction is one condition and the admission helper
  is the single home for a rule that had four copies; the rest of the growth is
  the docblock that stops the next reader restoring the exclusion, which three
  earlier pieces of work each recorded differently. Splitting this module is
  worth doing and must not ride along with a security change.

## `src/components/admin-sidebar.tsx`

Nine lines: one import, one `orAccess` predicate on the AI Diagnostics nav entry,
and the comment saying why that entry is admitted on ADMISSION rather than on a
permission area (ADR-002 §1, owner-ratified on #2370).

Without it this release would leave a visible inconsistency in the surface it
exists to fix: `canOpenAdminPath` admits any administrator to
`/admin/ai-diagnostics`, while the sidebar and command palette would keep
filtering the link on `overview:view` — so the shipped "Finance Viewer" grid
could open the page and never see the way in.

Splitting is genuinely worse here. The file's length is its nav TABLE, which is a
single declarative structure read top to bottom; cutting it into two modules to
make room for one predicate would put half the club's navigation in a second file
for no reason a reader would recognise.

file: src/components/admin-sidebar.tsx
lines: 1185
reason: one predicate plus its reasoning on the nav entry whose admission rule
  this release changes; leaving it out would ship a link the admitted user cannot
  see, and the file's bulk is one declarative nav table that gains nothing from
  being cut in half.
