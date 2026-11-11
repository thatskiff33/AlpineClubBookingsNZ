# File-size allowances for #4534 (issue #4466)

The axe checks this change adds to every E2E journey found controls with no
accessible name. Each file below grows only by the attribute lines that name an
existing control (`aria-label`, or an `id` with its label's `htmlFor`) and, in
the import dialog, the prop that carries the field's visible name to the select
that needs it. No file gains a new concern, and the explanatory comments first
written beside these fixes were dropped again so the growth is the attributes
alone. Moving a page's existing control out to a new file so that it can gain
an `aria-label` would be a split for its own sake.

file: src/app/(admin)/admin/config-transfer/page.tsx
lines: 649
reason: an aria-label on the bundle file input and on the per-row match
  select, the two unnamed controls axe reported on this page (label,
  select-name). Both are single attributes on controls that already exist.

file: src/app/(admin)/admin/display/builder/display-builder.tsx
lines: 1311
reason: one aria-label on each of the three option controls the module
  options editor renders (number, on/off, enum), naming each from the option
  descriptor's own label, which sits as an unassociated Label above them.

file: src/app/(admin)/admin/member-applications/_components/approval-mapping-panel.tsx
lines: 737
reason: one aria-label on the joining-fee invoice select, which axe reported
  as an unnamed select (select-name, critical) on member applications.

file: src/app/(admin)/admin/members/_components/member-import-dialog.tsx
lines: 882
reason: the column-mapping and date-format selects are rendered by two small
  helpers that did not receive the field's name; each gains a `label` prop,
  passed at its one call site, and uses it as the trigger's aria-label
  (button-name). The helpers already live beside the wizard step that uses
  them.

file: src/app/(admin)/admin/promo-codes/promo-redemptions-panel.tsx
lines: 818
reason: an id on the lodge filter select so its existing visible label can
  point at it (htmlFor), which also retires this file's one
  label-has-associated-control lint suppression.

file: src/app/(lodge)/lodge/kiosk/page.tsx
lines: 1425
reason: an id on the "Viewing as" select, whose visible caption becomes its
  label (htmlFor) instead of an unassociated span.

file: src/app/(lodge)/lodge/roster/[date]/setup/page.tsx
lines: 927
reason: one aria-label on the per-allocation person select, naming the chore
  it assigns, so each select in the list is distinguishable by name.

file: src/components/admin/induction-template-manager.tsx
lines: 747
reason: ids on the template type select and on each section's title input
  and priority select, so their existing visible labels point at them
  (htmlFor); three attribute lines on existing controls.
