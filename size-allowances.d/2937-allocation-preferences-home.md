# File-size allowances for #2937

file: src/components/admin/rooms-beds-manager.tsx
lines: 1511
reason: nine lines, and only two of them are code — the import of
  `AllocationPreferencesPanel` and the one element that mounts it. The other
  seven are the comment saying why the mount point sits OUTSIDE this file's
  `lodgeScopeReady` gate, which is the part a reader would otherwise "tidy"
  back inside and so delete the panel's per-scope explanation along with it.
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
