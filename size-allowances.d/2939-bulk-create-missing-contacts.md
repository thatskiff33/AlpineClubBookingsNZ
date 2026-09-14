# File-size allowances for #2939

Two files, and they are one change: the `INV-INT-018` two-homes refusal
arriving at a linker `INV-INT-019` had exempted, and the loop that now has to
say what it does with it.

**Two more files this change grows are declared elsewhere in this diff, on
purpose.** `src/lib/xero-contact-create-recovery.ts` and
`src/lib/xero-contacts.ts` already carry entries in
`size-allowances.d/3367-organisation-invoiced-party.md`, and those entries are
still LIVE: the size gate always judges against `origin/main`, whatever branch a
pull request targets, and no fragment on this epic branch has merged to `main`.
One file, one allowance — so their `lines:` are re-measured where they sit, with
this change's reasoning appended there, rather than duplicated here where the
gate would refuse the pair.

file: src/lib/xero-member-import.ts
lines: 1300
reason: #3058 adds five of these lines, four of them comment: the archived-skip
  test stopped hand-rolling `contactStatus.toUpperCase() !== "ACTIVE"` and now
  asks `isActiveXeroContactStatus`, the one home for which Xero statuses count
  as a live contact. It mattered because three readers of that one column each
  answered differently and Xero's enum carries `GDPRREQUEST` as well as
  `ARCHIVED`; the comment is the half that stops the next reader inlining the
  comparison back. Re-measured here, in the entry this file already has, because
  one file gets one allowance and the gate always judges against `origin/main`.
  #2939's own share, unchanged, is below.
  Twenty-five lines across the two member-create transactions, eighteen of
  them comment. Each create gains the contact-home lock before the insert and
  the refusal inside the same transaction after it, so a contact an
  `Organisation` already holds takes the new member row down with it rather than
  leaving a person claiming a school's Xero customer. The refusal runs after the
  create rather than before because it reads the OTHER table for a holder and
  needs an id only for the error it raises. This file is one long import loop
  over cached contacts; the two creates sit inside branches of that loop, so
  extracting them would mean threading the transaction, the mapping and the
  contact through a helper for no gain in readability.

file: src/lib/xero-bulk-contact-sync.ts
lines: 754
reason: Twenty-nine lines in one catch, and twenty of them are comment. The
  two-homes refusal reaches this loop now, and the loop had no bucket for it:
  the contact id went onto the retry list, which is PERSISTED into the sync
  cursor, so it was re-fetched and re-refused on every later sync with an error
  line in every report, for ever. The code is three lines routing it to
  `skippedOther` instead; the comment is why that is the right bucket and why a
  retry is not, which is the half a reader deleting it would get wrong. It
  belongs in the catch because that is where the next person choosing a bucket
  is standing, and the catch cannot be lifted out of the loop it guards.

**The tool's own three modules need no allowance, and that is the ratchet
working.** The census and the run were written as one module of about twelve
hundred lines, two thirds of it the comment that records why each
classification is not guessed. An allowance cannot cover that, and should not:
it lets an already-over-budget file grow, it is not a way to ARRIVE over
budget. So it is split at the seam that costs least — the shape
(`xero-missing-contact-seeding-shape.ts`, which imports nothing), the census
(`xero-missing-contact-seeding.ts`) and the run
(`xero-missing-contact-seeding-run.ts`) — and every piece is inside its ceiling.
The shape module's own docblock records the second thing that split bought: the
admin panel keys its reason-to-copy maps on the engine's unions, and a
`"use client"` file can now take them from a leaf that imports nothing rather
than from a module that imports `prisma`.
