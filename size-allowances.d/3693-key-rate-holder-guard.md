# File-size allowances for #3691 and its #3693 CI repair

file: src/app/(admin)/admin/membership-types/page.tsx
lines: 1903
reason: the repair control shares the existing membership-type editor draft and
  permission state; splitting only this control would duplicate that state.

file: src/app/api/admin/membership-types/[id]/route.ts
lines: 474
reason: the protected-key validation must sit beside the existing parsed PATCH
  update so ordinary fields and repair-only fields are evaluated together.

file: src/lib/setup-readiness.ts
lines: 2262
reason: the new drift finding is one rule in the existing setup snapshot and
  shares its warning assembly; a separate module would fragment that contract.
