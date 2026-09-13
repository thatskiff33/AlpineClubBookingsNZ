# File-size allowances for #2695 — member-visible audit text is declared

Five already-over-budget files grow. (`audit.ts` and `audit-query.ts` were
here too; #2704 grew both further and its own fragment now carries them, so the
gate sees one live allowance per file. The split note below still applies to
them.) **One split was taken rather than allowed
for:** the declaration's vocabulary, its reserved-key rules and the reasoning
for all of it are a new module, `src/lib/audit-member-disclosure.ts`, well
inside its own budget — so `audit.ts` and `audit-query.ts` gain the mechanism's
call sites and not its explanation.

Comment compression was taken too, before reaching for any of this. The
`adminNotes` justification was written out at five call sites and is now four
lines at each, pointing at `INV-PRIV-017` for the rest; that alone returned
thirty-odd lines across the three routes below.

The four routes' growth is irreducible in the same way at each: the declaration
is three lines of code that MUST sit on the event object, at the write site,
because that is the whole point of the change — a declaration lifted into a
helper is a declaration a reviewer cannot see beside the text it governs.

file: src/lib/member-credit.ts
lines: 947
reason: the owner's decided site. Three lines of declaration plus the comment
  saying why the member's sentence is written out rather than reusing `details`
  — which names the adjustment request, the credit row and the requesting
  member. Without that note the next reader deletes the "duplication".

file: src/app/api/admin/bookings/[id]/review/route.ts
lines: 350
reason: two declarations, approve and reject, three lines each with the
  compressed note above. There is no seam: both sit inside branch-specific
  `logAudit` calls that already differ in action, summary and metadata.

file: src/app/api/admin/booking-exception-requests/[id]/route.ts
lines: 792
reason: the same, for the refuse and approve decisions. The approval's note is
  the longer of the two because its `details` falls back to the reviewed policy
  codes when an officer writes nothing, and the declaration deliberately does
  NOT follow that fallback — a code is an internal identifier for the rule that
  was waived, not a sentence written for a member, and the comment is what stops
  the next reader restoring the symmetry.

file: src/app/api/member/data-export/route.ts
lines: 352
reason: the data export is the second member-facing audit channel and it read
  `AuditLog.details` raw, so the deletion-decline note written under "do not
  notify the member" came back in the member's own download. The growth is the
  swap to `metadata` plus the two comments that say why the column a reader
  expects to see here is deliberately absent — the field keeps its name and
  changes its source, which is exactly the kind of change a later reader
  "corrects" without the note. Splitting is not available: this route is one
  linear disclosure document assembled in one function, and the audit block is
  eleven lines of it.

file: src/app/api/admin/deletion-requests/[id]/route.ts
lines: 1295
reason: the rejection note's `internal` declaration is the case this issue was
  opened for, so its seven-line comment says what the "do not notify the member"
  tick used to fail to mean. Its approval sibling takes two lines and a
  one-sentence pointer back.
