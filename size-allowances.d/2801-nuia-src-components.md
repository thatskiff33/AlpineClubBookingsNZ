# File-size allowances for #2801

file: src/components/admin/booking-bed-allocation-panel.tsx
lines: 1120
reason: a bed-run's shared bedId/bedName/roomName is now read once via a
  destructured firstAllocation guard (with its explaining comment) instead of
  three unsafe group[0] indexes; the guard has to sit beside the grouping loop
  it protects, and that loop is already deep inside this panel's rendering
  logic — lifting it out would split one grouping decision across two files.

file: src/components/admin/induction-template-manager.tsx
lines: 744
reason: four draft-mutation helpers (patchSection, patchItem, addItem,
  removeItem) each gained a one-line guard plus a short comment explaining why
  a stale index is a no-op rather than a crash; each guard has to stay next to
  the array read it protects, so the growth is spread across the file's
  existing structure rather than addable to one seam.

file: src/components/admin/subscription-lockout-settings-panel.tsx
lines: 791
reason: three lines. monthName's 12-entry lookup now falls back to the exact
  "Unknown" string the function already returns for an out-of-range month,
  with a comment saying why the fallback can only fire if that guarantee is
  ever violated.

file: src/components/edit-booking-panel.tsx
lines: 2135
reason: eight lines across two independent fixes: buildModificationPayload's
  min/max-night reduces gained a short comment explaining the no-seed
  `.reduce()` change, and handleToggleGuestNight gained a three-line guard
  (with comment) for a row lookup the grid's own construction already proves
  in range. Both sit beside the logic they explain; this file is already the
  named worst-case for splitting in this codebase's own docs.

file: src/components/website/skifield-whakapapa-widget.tsx
lines: 745
reason: one line net. groupTrailAreas was rewritten from an offset-indexing
  while loop to a single forward pass with no lookahead, which needed a
  seven-line explaining comment the original two-line comment didn't carry;
  the net file growth is one line because the rewritten function body is
  shorter than the original.
