# File-size allowances for #2695 — member-visible audit text is declared

**#2704 raised two of these numbers, and edited this file rather than adding its
own.** The gate refuses two LIVE allowances for one file ("one file, one
allowance"), and measured against `origin/main` — the base CI uses — #2695 has
not merged there yet, so its fragment is still live in #2704's diff. A second
fragment naming `audit.ts` or `audit-query.ts` would therefore be refused
outright, and the gate's own remedy is to correct the number here. Each entry
below says which issue's growth is which, so the reason text stays true to the
lines it is describing.

Six already-over-budget files grow. **One split was taken rather than allowed
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

file: src/lib/audit.ts
lines: 895
reason: #2704 adds 58 of these lines and #2695 the rest. #2704's share is the
  `details` column's over-budget branch, which is where the two boundaries
  around the structural reduction are decided: a payload that FITS takes the
  text rule byte for byte, and one that does not is re-sanitised as metadata,
  which redacts strictly more. The rule itself and the measured
  `"amountCents":1` case were deliberately NOT restated here — they live in
  `audit-structured-detail.ts`, which is the split this change took rather than
  allowing for, and the comment compression of this file's first draft is what
  keeps the share to 58. It cannot move: it is the sanitiser for one column, and
  a column's write boundary is where a reader looks for what that column stores.
  #2695's share, below, is unchanged. The two write boundaries route their metadata through one new builder,
  and the docblock on it is the deliverable rather than decoration — the ORDER
  it imposes is load-bearing and invisible from the code. The caller's metadata
  is sanitised first and the declared member text attached afterwards, because
  merging the text in first would let an over-budget payload silently delete
  what the member reads. That is the same defect as the shape test this issue
  removed, in a second disguise, and the next person to "simplify" the two steps
  into one will reintroduce it. The rest is the optional `memberDisclosure`
  field on both writer param types, said once and re-exported.

file: src/lib/audit-query.ts
lines: 1322
reason: #2704 adds 40 of these lines and #2695 the rest. #2704's share threads
  one fact — the `details` column holds a payload, parsed or rebuilt — through
  the serializer, `projectFreeTextForAudience` and `getDescription`, so a legacy
  clipped payload renders as fields instead of being handed back as a sentence.
  It has to be threaded rather than re-derived at each reader: three readers
  each asking "did it parse?" is how the audience came to be a property of the
  JSON parser in the first place, which is the defect #2695 removed from this
  same file. The recovery ITSELF is in `audit-structured-detail.ts`; what is
  here is only the wiring and the two comments saying why the raw column stays
  on screen beside a recovered view. #2695's share, below, is unchanged.
  `projectFreeTextForAudience` answers every free-text field for both
  audiences in one exhaustive place, replacing three ternaries spread through
  the serializer, and `storedSummary` beside it is the single fallback rule the
  two audiences' row titles share — written twice with two different emptiness
  tests, it showed a member a blank row title where an officer saw the derived
  one. It cannot move to the new module: it composes `getSummary`,
  `getDescription` and the legacy-metadata parse, all of which live here, so
  lifting it out means either a circular import or four callbacks passed in to
  reach the same result. Its docblock carries why the audience must be answered
  in one place at all — `INV-PRIV-012` records a guard on this surface that was
  measured to survive deletion with the word left behind in a comment.

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
