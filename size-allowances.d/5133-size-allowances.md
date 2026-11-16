# Size allowances for #5133

file: src/app/(admin)/admin/lodges/[id]/setup/page.tsx
lines: 969
reason: moves this wizard's action failures (identity, rooms, lockers, and a
  season or chore copy that fails as a whole) onto the shared useActionFailure
  hook and a permanently mounted FocusedActionError, which is four lines longer
  overall. A copy where only some rows are refused still lists them in its
  summary, as before. The file was already over its limit before this change,
  and splitting the wizard apart is a refactor of its own, not part of this
  fix.

file: src/app/(admin)/admin/website/site-style/site-style-wizard.tsx
lines: 1041
reason: moves this wizard's save and logo-upload failures onto the shared
  useActionFailure hook and a permanently mounted FocusedActionError, which is
  four lines longer overall. The file was already over its limit before this
  change, and splitting the wizard apart is a refactor of its own, not part of
  this fix.

function: src/app/(admin)/admin/lodges/[id]/setup/page.tsx#LodgeSetupWizardPage
lines: 853
reason: the same conversion of the wizard's action failures lands inside
  `LodgeSetupWizardPage`, which was already over its function limit before this
  change. Splitting the component is a refactor of its own, not part of this
  fix.

function: src/app/(admin)/admin/website/site-style/site-style-wizard.tsx#SiteStyleWizard
lines: 844
reason: the same conversion of the wizard's save and logo-upload failures lands
  inside `SiteStyleWizard`, which was already over its function limit before
  this change. Splitting the component is a refactor of its own, not part of
  this fix.
