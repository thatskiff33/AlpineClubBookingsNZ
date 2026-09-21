# File-size allowances for #3563 — the club's currency and locale become a setting

Five already-over-budget files grow, by two to twenty-three lines each. **Two
splits were taken rather than allowed for**, and they are the reason this list
is as short as it is:

- the boot backfill's definition went into a new module,
  `src/lib/config-self-heal-club-format.ts`, rather than becoming a sixth
  definition in `config-self-heal-steps.ts`. That file was inside its budget on
  the base ref, so an allowance could not have carried it over for the first
  time and should not have been asked to — the seam
  `config-self-heal.ts` already names (a step whose value comes from the
  environment rather than from `config/club.json`) was there to be used.
- the whole of the new setting — its validators, its environment seed, its
  reader, its admin-payload builder, its route, its page and its panel — is
  seven new modules, every one of them inside its own budget. Nothing was added
  to an existing settings module.

Two of the five below are the `INV-SSOT-003` currency ratchet (owner decision
D5): `src/lib/stripe.ts`'s two `currency = APP_STRIPE_CURRENCY` defaults are
deleted, so each call site states the currency. That is two lines per call site
— one import, one property — and it is irreducible by construction: the whole
point of deleting a default is that the value appears at the call site where a
reader can see it, so lifting it back into a shared helper would restore the
defect under a different name.

file: src/app/api/payments/create-payment-intent/route.ts
lines: 817
reason: the INV-SSOT-003 ratchet. One import of APP_STRIPE_CURRENCY and one
  `currency:` property on the createPaymentIntent call. There is no seam: the
  point of deleting the default is that the currency is stated where the charge
  is made, and a helper that supplied it again would be the deleted default
  wearing a new name.

file: src/lib/group-settlement.ts
lines: 1269
reason: the same two lines, for the group-settlement intent. Same reasoning.

file: src/lib/payment-recovery.ts
lines: 3158
reason: the same two lines, for the modification-additional recovery intent.
  Same reasoning. This file is the largest in the tree and badly wants
  splitting, but that is a refactor of its own and doing it inside a schema
  change would make both unreviewable.

file: src/lib/admin-permissions.ts
lines: 992
reason: the two `/admin/club-format` and `/api/admin/club-format` prefixes plus
  the seven-line comment saying why they are registered under `support` when
  both verbs enforce Full Admin. That comment is the one that stops the next
  reader "correcting" the area and silently admitting a support editor — the
  club-time and environment-safety prefixes above carry the identical note for
  the identical reason, and the file is a single ordered registry with no seam
  that would not separate a prefix from the explanation of why it is there.

file: src/components/admin-sidebar.tsx
lines: 1208
reason: one nav entry — href, label, icon, `fullAdminOnly`, eight search
  keywords and the six-line note saying why the keywords exist (the label
  matches none of the words an operator types, and the command palette index is
  built from these entries). The file is one declarative nav tree; splitting it
  would put a section's entries in a different file from the order they appear
  in, which is the one thing a reader of this file needs to see at once.
