# File-size allowances for #5056 (officer two-factor, #4618)

The officer rule's logic lives in new modules (`officer-two-factor.ts`,
`officer-two-factor-grace.ts`, `officer-two-factor-claims.ts`,
`officer-factor-reset.ts`, `two-factor-gate.ts`). What remains in these five
already-oversized files is the wiring that has to sit where the existing
behaviour sits.

file: src/lib/auth.ts
lines: 977
reason: the JWT refresh callback is where every session claim is recomputed;
  the three officer claims must be set beside twoFactorRequired in the same
  refresh, or a token could carry a stale officer state. The computation is
  already delegated to resolveOfficerTwoFactorClaims; what grows is the claim
  declaration, the call and the three token and session assignments. Lifting
  the refresh callback out of auth.ts is a security refactor of its own.

file: src/lib/config-transfer/categories/club-settings.ts
lines: 1228
reason: the two officer policy columns must be named in the club-settings
  category's `excluded` map, with the reason they never travel; the transfer
  census reads that map in this file, so the entry cannot live elsewhere.

file: src/lib/email-message-registry.ts
lines: 2470
reason: the new officer-factor-reset message has to be registered in the
  single message registry (merge fields and trigger summary); the registry is
  one table by design and splitting it for one entry is worse.

file: src/app/(authenticated)/profile/page.tsx
lines: 711
reason: the profile page passes the officer requirement and the grace deadline
  label into the two-factor card it already renders. Building those props is
  delegated to officerTwoFactorCardProps in officer-two-factor-grace.ts; what
  remains is that call, the import and one spread prop, which only this
  server component can supply.

function: src/app/(authenticated)/profile/page.tsx#ProfilePage
lines: 581
reason: two lines: the officerTwoFactorCardProps call and its spread into the
  security card the page already renders. The props are built outside the
  function; the card's other inputs are read in this body, so the call has to
  sit beside them.

file: src/app/(admin)/admin/membership/members/[id]/page.tsx
lines: 1356
reason: the reset control is rendered inline beside the member's other account
  actions. Its gate (switch, Full Admin, not self, not the kiosk) and the
  button live in officer-factor-reset-button.tsx; only the import and the one
  element remain here.

function: src/app/(admin)/admin/membership/members/[id]/page.tsx#MemberDetailPage
lines: 1246
reason: one line, the OfficerFactorResetSlot element in the Account & Access
  group; everything it decides lives in its own component, and moving the
  group out of this page is a refactor of its own.
