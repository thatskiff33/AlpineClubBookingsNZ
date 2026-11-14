# Size allowances for #5094

function: src/app/(admin)/admin/setup/setup-page-client.tsx#SetupPageClient
lines: 425
reason: gates Setup Wizard writes on support edit access; those lines sit
  inside the function `SetupPageClient`, which was already over its limit
  before this change, and lifting it apart is a refactor of its own, not part
  of this fix.
