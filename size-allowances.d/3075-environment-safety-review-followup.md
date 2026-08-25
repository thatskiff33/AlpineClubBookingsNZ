# File-size allowances for #3075 (external-review follow-up to epic #2986)

**One entry, and one deletion. Both are what the gate asked for by name.**

## Why `2986-environment-safety.md` is deleted rather than edited

That file was epic #2986's allowance, and **it is spent**: the epic merged, so
every length it records IS the length on `origin/main`, and the gate reports each
of its seventeen entries as "an allowance the check did not need … one left
behind is a stored exception, which is the thing this gate no longer has".

Sixteen of those seventeen files are untouched by this change, so sweeping them
costs nothing and can create no finding — the ratchet judges only the files a
change actually modifies. The seventeenth, `src/lib/xero-contacts.ts`, this
change does grow, and it is re-declared below at its new length.

Editing the old file in place was tried first and is wrong twice over: it leaves
the sixteen stale entries standing, and it puts this change's reasoning inside
another change's allowance. Sweeping a merged allowance file is the established
move here — #3034 deleted `size-allowances.d/3000-club-time-zone.md` for exactly
this reason, and `size-allowances.d/README.md` says a merged allowance is inert
and can be swept in bulk. This file is that sweep plus this change's one entry.

## The one entry

file: src/lib/xero-contacts.ts
lines: 1891
reason: fifteen lines of comment, and no code. An external reviewer on #3071
  found a time-of-check/time-of-use window: `findOrCreateXeroContact` resolves the
  contact-email policy once, at the top, and then does all of its Xero work —
  an OAuth refresh, up to two searches, a `createContacts`, and `callXeroApi`'s
  retry sleeps, which reach 120 seconds. An administrator switching the safer
  override on during that leaves one contact written under the previous answer.
  It is documented rather than closed, deliberately: a lock spanning those
  provider calls is precisely the F7 (#1355) failure this function was
  restructured to remove, and a re-resolve between its phases would narrow the
  window while inviting the next reader to believe it was gone. The note has to
  sit on the `resolveXeroContactEmailPolicy` call it describes, because the whole
  subject is what happens between that line and the writes below it — moving it
  elsewhere separates the caveat from the call that carries it, which is how the
  two hosting exceptions drifted apart. The function itself is unchanged here.

## The other file this change grew is deliberately not listed

`src/lib/xero-group-settlement-invoices.ts` went 697 → 752 when the in-lock
re-check landed with its reasoning, which would have crossed its 700-line budget
for the **first** time — and an allowance is explicitly not available for that.
Splitting it was the other option and was rejected on the merits: the extraction
would move a `pg_advisory_xact_lock(1)` site into a new module and need its own
`GLOBAL_LOCK_SITE_REGISTRY` entry, which is a far larger change to a Critical path
than this fix warrants. So the reasoning moved into
`reassertXeroInvoiceEmailPolicy` in `xero-invoice-email.ts` — the module that owns
the rule, and the module every caller reads it from — leaving the file at 699.

That is now the **third** time this epic has applied that exact remedy to that
exact file (the deleted allowance's own header records the first two), which is
itself the strongest argument for the shared helper.
