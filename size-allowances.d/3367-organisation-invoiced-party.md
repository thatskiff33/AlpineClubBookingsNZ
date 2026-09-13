# File-size allowances for #3367 (stage 2 of programme #2912)

Five already-over-budget files grow here, and one new module was split rather
than allowed — `organisation-xero-contacts.ts` came in at 859 lines, so its
contact-person half moved to `organisation-xero-contact-persons.ts` and both
halves now sit inside the budget. The five below are cases where the split is
genuinely the worse answer. Three of them, and the growth in the other two,
come from the adversarial review round rather than from the first build.

file: src/lib/school-booking-request.ts
lines: 2735
reason: The school approval transaction gains the resolve-or-create of the
  school's own `Organisation`, the link from the booking and the request, and
  the teacher association. Every one of those writes has to happen INSIDE the
  existing transaction, under the global lock it already holds — that lock is
  the unique-name claim that stops two concurrent approvals minting two schools
  for one name — so lifting them into a module would either move the lock with
  them or leave a helper whose correctness depends on a caller it cannot see.
  The resolve itself IS extracted, to `school-organisations.ts`, because the
  matching rule is a fact two more callers will need (#2936, #3369). What is
  left here is the call and its three writes, plus the comments explaining why
  the invented member and the teacher's `Role.SCHOOL` literal deliberately
  survive this stage. Splitting the approval transaction is a real piece of
  work and it belongs to stage 3 (#3368), which rewrites this area's ownership
  reads anyway.

file: src/lib/xero-contacts.ts
lines: 1920
reason: Three lines net. The member payload builder's object literal MOVED OUT
  to `xero-contact-shape.ts`, which the organisation builder shares, so the
  single-source-of-truth direction of this change is a reduction. What is added
  back is the two-homes refusal in phase 2 — four statements and the comment
  explaining why a school's contact can otherwise be linked to a member
  deterministically rather than by a race — plus two export keywords and their
  docblocks, so the organisation path can share this module's name search and
  duplicate-name predicate rather than copying them.

file: src/lib/xero-booking-invoices.ts
lines: 1428
reason: Six lines, and five of them are the comment. One call site changes from
  `findOrCreateXeroContact(booking.memberId, …)` to
  `findOrCreateXeroContactForInvoicedParty(booking, …)`. The comment is there
  because the whole of "the organisation becomes the invoiced party" is that one
  line — an invoice payload sends a contact reference and no name — and a reader
  who does not know that will go looking for a change in the eleven invoice
  builders that is not there.

file: src/lib/xero-operation-retry.ts
lines: 1450
reason: Thirty-six lines, admitting the ORGANISATION case on the retry screen.
  The screen gated contact create and update on `localModel === "Member"`, so an
  officer replaying a school's failed contact operation was told it "requires a
  member-local record" — for exactly the operations this stage's module docblock
  and the officer guide promise stay replayable. Half the lines are the two
  support-gate branches and the two dispatch branches that answer it; the rest
  is the comment saying why a replay is safe (the organisation-scoped
  idempotency key converges it on one contact) and why ONE branch covers both
  the contact-person refresh and the organisation-shape correction. This file is
  a single dispatcher over every retryable operation type, deliberately: a
  second dispatcher for one entity type is how two screens come to disagree
  about what is retryable, which is the defect the file exists to prevent.

file: src/app/api/admin/xero/import-member-contact/route.ts
lines: 393
reason: Forty lines, of which thirty are the comment. This route is a writer the
  stage NEWLY EXPOSES: it creates a `Member` carrying a `xeroContactId` and
  never read `Organisation`, and before the transfer a school's contact was held
  by the invented school member and so never appeared in this screen's list of
  unlinked contacts. After the transfer it does, and the route's name-split
  fallback would turn a school name into a first and a last name. The code is
  the contact-home lock, the shared refusal, and a 409 that names the holder —
  eight lines that cannot live anywhere else, because the guarantee is that the
  refusal happens inside THIS route's transaction. The comment is long because
  the reachability is the part a reader cannot reconstruct: it explains why a
  route that was safe last release is not safe this one.

## Added by the second fix round

Both of these are comment-only growth, and both are the fix: a lock-order rule
and a merge-semantics rule that a next author reads AT the function rather than
in a guide they have no reason to open. The first fix round corrected the guide,
the invariant and the lock-guard test and left these two sentences teaching the
order that produced the deadlock, which is exactly how the rule stops holding.

file: src/lib/xero-contact-create-recovery.ts
lines: 844
reason: Fourteen comment lines across two docblocks, no code. The manual-link
  fence called the target `Member` row the transaction's FIRST lock; the
  contact-home key is taken before it, and the sentence as written described the
  deadlock `INV-LOCK-002` now forbids. Both the shared row fence and the
  manual-link fence say the order, because a fifth linker reads whichever one it
  calls. The docblock cannot move: a lock-order rule stated anywhere but at the
  lock is a rule somebody has to go and find.

file: src/lib/xero-sync.ts
lines: 883
reason: Eleven comment lines on `XeroObjectLinkInput.mergeMetadata`, no code. The
  flag's docblock said only inbound writers set it while one outbound writer
  now does, for a sound reason; two comments contradicting each other is how a
  reader "corrects" the specific writer back to replace semantics and silently
  disables the adopted-contact reshape that depends on its provenance marker.
  The rule belongs on the field it governs, where the next caller chooses.
