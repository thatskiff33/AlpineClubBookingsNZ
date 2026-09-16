# File-size allowances for #2937

file: src/components/admin/rooms-beds-manager.tsx
lines: 1511
reason: seventeen lines, of which exactly two are code — the import of
  `AllocationPreferencesPanel` and the one element that mounts it. The other
  fifteen are a blank separator and the fourteen-line comment saying why the
  mount point sits OUTSIDE this file's `lodgeScopeReady` gate, which is the
  part a reader would otherwise "tidy" back inside and so delete the panel's
  per-scope explanation along with it. That tidy is now a test failure rather
  than a comment nobody reads: four cases in `rooms-beds-manager.test.tsx` and
  two in `rooms-beds-allocation-preferences-integration.test.tsx` assert the
  card is still there in each unsettled scope.
  The whole point of hosting the editor here is that it reads this manager's
  own `lodgeScope` — one lodge selector on the page, one derivation, one
  committed scope — so the mount cannot move to a sibling component or to the
  server page without re-creating the second selector this change exists to
  avoid. Everything else the relocation needed went the other way: the editor,
  its per-scope card and its two suites live in
  `src/components/admin/allocation-preferences-section.tsx`, not here. This
  file's own size debt predates the change and is untouched by it; its real
  seam is between the room list, the bed rows and the bulk-create card, which
  is a piece of work in its own right rather than something to attempt while
  adding a card to the foot of the page.

file: src/lib/admin-permissions.ts
lines: 961
reason: RE-MEASURED at 961 for #2940, which adds six lines to the same file
  while this allowance is still live in the diff against `origin/main` — one
  route prefix (`/admin/video-meetings`) in the finance area's list, and five
  comment lines saying why it is finance, why its API needs no prefix of its
  own, and why it is not feature-gated. A second allowance file naming the same
  path would be refused ("one file, one allowance"), so the number moves here.
  What follows is #2937's own reason, unchanged, which is still what accounts
  for the bulk of the debt: fifty-five lines registering the third adjudicated
  admission rule, on
  the exact shape of the second (`isConsolidatedFeesPath` /
  `canAccessConsolidatedFeesPage`, #1933). Eight are code — a path constant, a
  prefix test and a two-term predicate — and the rest is why, which is the part
  that has to be here. This is an authorization WIDENING: it lets a
  bookings-area admin open a page the route map registers under `lodge`, and a
  reviewer reading the diff cannot tell a deliberate OR from a mis-registered
  prefix without being told which. The comment names the two seeded roles it
  admits, the reason the page's content has always been bookings-gated while its
  route is not, and the direction it moves access in.
  Splitting is the wrong answer for the same reason it was in #1933: this module
  IS the single home of the admin route -> area map and of every exception to
  it, and `admin-route-authorization-proof.test.ts` drives the real guard over
  the real map from here. An exception living in a second module is how the fee
  console's OR rule came to have two spellings that drifted apart, which #2975
  fixed by bringing them back to one. The file's own size debt predates this
  change and its real seam — the bundles and the level algebra, apart from the
  route map — is a piece of work in its own right.
