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
lines: 1206
reason: the two officer policy columns must be named in the club-settings
  category's `excluded` map, with the reason they never travel; the transfer
  census reads that map in this file, so the entry cannot live elsewhere.

file: src/lib/email-message-registry.ts
lines: 2470
reason: the new officer-factor-reset message has to be registered in the
  single message registry (merge fields and trigger summary); the registry is
  one table by design and splitting it for one entry is worse.

file: src/app/(authenticated)/profile/page.tsx
lines: 731
reason: the profile page passes the officer requirement and the grace deadline
  label into the two-factor card it already renders; the label is formatted
  by formatOfficerGraceDeadline, and the remaining lines are the session reads
  and props that only this server component can supply.

file: src/app/(admin)/admin/membership/members/[id]/page.tsx
lines: 1363
reason: the reset button is rendered inline beside the member's other account
  actions, gated on the switch, Full Admin, not self and not the kiosk; the
  button itself is a separate component and only the gate and import remain.
