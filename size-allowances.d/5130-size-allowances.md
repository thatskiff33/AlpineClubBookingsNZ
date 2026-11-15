# Size allowances for #5130 (admin save and delete failures, #4976 follow-up)

Each of the four handlers gains a named fallback sentence and a branch for a
request that never gets an answer, and reads a refusal through the shared
`apiErrorMessageFromResponse`. Moving one handler out of an oversized page to
save those lines would scatter a page's own save logic, and splitting these
pages is a refactor of its own.

## File lengths

file: src/app/(admin)/admin/membership/family-groups/page.tsx
lines: 899
reason: the create handler had no catch at all; the shared-reader import, the
  named fallback and the network-failure branch are the whole fix.

file: src/app/(admin)/admin/rules/fees/_components/hut-fees-section.tsx
lines: 1279
reason: the save handler gains the shared-reader import and a named fallback
  so the refusal and the network failure say the same sentence.

file: src/app/(admin)/admin/work-parties/page.tsx
lines: 624
reason: the delete handler had no network-failure path and parsed before
  checking res.ok; the import, fallback and null-response branch are the fix.

## Function lengths

function: src/app/(admin)/admin/membership/family-groups/page.tsx#FamilyGroupsTab
lines: 838
reason: the create-and-edit submit handler, which sits inside this function,
  gains a named fallback sentence and a catch for a request that never gets an
  answer; the function was already over its limit before this change, and
  lifting the handler out is a refactor of its own, not part of this fix.

function: src/app/(admin)/admin/rules/fees/_components/hut-fees-section.tsx#HutFeesSection
lines: 1133
reason: the season save handler, which sits inside this function, now reads a
  refusal through the shared reader and shows a named fallback sentence when
  the request fails; the function was already over its limit before this
  change, and lifting the handler out is a refactor of its own.

function: src/app/(admin)/admin/rules/seasons/page.tsx#SeasonsPage
lines: 415
reason: the season save handler, which sits inside this function, now reads a
  refusal through the shared reader and shows a named fallback sentence when
  the request fails; the function was already over its limit before this
  change, and lifting the handler out is a refactor of its own.

function: src/app/(admin)/admin/work-parties/page.tsx#AdminWorkPartiesPage
lines: 463
reason: the delete handler, which sits inside this function, gains a branch
  for a request that never gets an answer and reads a refusal through the
  shared reader; the function was already over its limit before this change,
  and lifting the handler out is a refactor of its own.
