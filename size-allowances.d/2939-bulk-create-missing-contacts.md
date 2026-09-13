# File-size allowances for #2939

Both entries are the same change in two places: the `INV-INT-018` two-homes
refusal arriving at the two linkers `INV-INT-019` had exempted. Neither file has
a seam this change created, and neither gained a feature — what they gained is a
guard on a write they were already making.

`src/lib/xero-contact-create-recovery.ts` is declared in
`size-allowances.d/3367-organisation-invoiced-party.md`, which already held an
allowance for it — one file, one allowance, so that entry's number was moved to
the file's real length rather than a second one added here. The reasoning for
this change's share of it: thirty-five lines, and twenty-eight of them are comment. The code is the contact-home lock taken before the member row fence, the refusal at the moment the patch CLAIMS a link, and one import. The comment is why the lock goes FIRST — taking it after the row fence is the deadlock `xero-contact-home.ts` describes, resolved by Postgres with 40P01 — and why the refusal is narrowed to the claim, since a blank-field backfill onto the record already holding the contact cannot give it a second home and refusing one would break an unrelated repair. Both are invisible at the call site and both are exactly what a later reader would otherwise "simplify" away. There is no split available: the lock, the fence and the patch are one short transaction whose whole correctness is their order.

file: src/lib/xero-member-import.ts
lines: 1295
reason: Twenty-five lines across the two member-create transactions, eighteen of them comment. Each create gains the contact-home lock before the insert and the refusal inside the same transaction after it, so a contact an `Organisation` already holds takes the new member row down with it rather than leaving a person claiming a school's Xero customer. The refusal runs after the create rather than before because it reads the OTHER table for a holder and needs an id only for the error it raises. This file is one long import loop over cached contacts; the two creates sit inside branches of that loop, so extracting them would mean threading the transaction, the mapping and the contact through a helper for no gain in readability.
