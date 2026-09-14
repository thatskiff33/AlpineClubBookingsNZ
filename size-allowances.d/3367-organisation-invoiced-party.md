# File-size allowances for #3367 (stage 2 of programme #2912)

Five already-over-budget files grow here, and one new module was split rather
than allowed — `organisation-xero-contacts.ts` came in at 859 lines, so its
contact-person half moved to `organisation-xero-contact-persons.ts` and both
halves now sit inside the budget. The five below are cases where the split is
genuinely the worse answer. Three of them, and the growth in the other two,
come from the adversarial review round rather than from the first build.

file: src/lib/school-booking-request.ts
lines: 2740
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
lines: 2046
reason: Three lines net. The member payload builder's object literal MOVED OUT
  to `xero-contact-shape.ts`, which the organisation builder shares, so the
  single-source-of-truth direction of this change is a reduction. What is added
  back is the two-homes refusal in phase 2 — four statements and the comment
  explaining why a school's contact can otherwise be linked to a member
  deterministically rather than by a race — plus two export keywords and their
  docblocks, so the organisation path can share this module's name search and
  duplicate-name predicate rather than copying them.
  #2939 then added a hundred and twenty-six more lines, ninety-one of them
  comment: `requireAuthoritativeMatch`, which lets a BULK caller say "if the
  provider cannot be asked authoritatively, do nothing for this member". It
  turns a failed Xero search and a name-uniqueness refusal from fall-throughs
  into refusals, at the two places this function otherwise proceeds on an answer
  it does not have. The comment weight is the point: the DEFAULTS are right for
  every existing caller and invert only for a bulk run, so each refusal site
  carries which trade it is making, or the next reader "fixes" the option away.
  It cannot live anywhere else — an option that changes what this function does
  at two specific branches has to be read at those branches, and a wrapper would
  have to re-implement the search and the recovery to intercept them, which is
  the duplicate resolution path `INV-SSOT` exists to prevent. The number here is
  the file's real length rather than a second entry the gate cannot choose
  between — one file, one allowance, and every fragment in this diff is live
  because the size gate always judges against `origin/main`, where none of them
  has merged.

file: src/lib/xero-booking-invoices.ts
lines: 1597
reason: Six lines, and five of them are the comment. One call site changes from
  `findOrCreateXeroContact(booking.memberId, …)` to
  `findOrCreateXeroContactForInvoicedParty(booking, …)`. The comment is there
  because the whole of "the organisation becomes the invoiced party" is that one
  line — an invoice payload sends a contact reference and no name — and a reader
  who does not know that will go looking for a change in the eleven invoice
  builders that is not there.
  #3368's ownership sweep then added this file's one-line `bookingOwner` import, so the length recorded here is the length after that import; the reasoning above is unchanged.
  RE-MEASURED AGAIN by #3001, which added seventeen lines, twelve of them
  comment. Three of the code lines record WHICH of the three faults stopped the
  invoice email — the provider call, an unreadable "No emails" switch, or an
  unconfirmed installation role — as its own payload key, because the error
  VALUE is not redacted and is never read back, so without the key the booking's
  warning can only say "sending it failed" and hands an officer a remedy that
  fits two of the three. The others are the key on the completion payload and
  the shared correlation-key import. The number is re-measured in this fragment
  rather than declared in a second one, which is what the gate asks — one file,
  one allowance.

file: src/lib/xero-operation-retry.ts
lines: 1482
reason: RE-MEASURED by #3001, which added ten lines here: the money fence
  `partialInvoiceOperationHasPaymentFault` now reads the completion payload
  through `readXeroInvoiceOperationOutcome` rather than spelling all six keys
  inline, because #3001's warning on the booking is a second reader of the same
  six. The checks and their order are unchanged and the suite passes unchanged;
  the added lines are the note saying so. The number is re-measured in this
  fragment rather than declared in a second one, which is what the gate asks.
  The original reason stands: thirty-six lines, admitting the ORGANISATION case
  on the retry screen.
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
lines: 883
reason: Fourteen comment lines across two docblocks, no code. The manual-link
  fence called the target `Member` row the transaction's FIRST lock; the
  contact-home key is taken before it, and the sentence as written described the
  deadlock `INV-LOCK-002` now forbids. Both the shared row fence and the
  manual-link fence say the order, because a fifth linker reads whichever one it
  calls. The docblock cannot move: a lock-order rule stated anywhere but at the
  lock is a rule somebody has to go and find. #2939 then added thirty-five more
  lines to the same file, twenty-eight of them comment: the contact-home lock,
  the two-homes refusal at the moment `applyInboundMemberContactPatch` CLAIMS a
  link, and why each of those two things is where it is. The number here is the
  file's real length rather than two entries the gate cannot choose between —
  one file, one allowance — and the #2939 reasoning is in
  `size-allowances.d/2939-bulk-create-missing-contacts.md` beside it.
  RE-MEASURED AGAIN by #3001, which added four lines: three of comment and one
  import, because the `ORPHANED_STALE_RUNNING` error code this module read as a
  literal is now minted once in `xero-stale-operations.ts`. The reset route
  writes that string and #3001's booking warning reads it — to tell an operation
  that FAILED from one nobody saw through — so three places depended on one
  spelling. The export keeps this module's name so its callers are unchanged.

file: src/lib/xero-sync.ts
lines: 901
reason: Eleven comment lines on `XeroObjectLinkInput.mergeMetadata`, no code. The
  flag's docblock said only inbound writers set it while one outbound writer
  now does, for a sound reason; two comments contradicting each other is how a
  reader "corrects" the specific writer back to replace semantics and silently
  disables the adopted-contact reshape that depends on its provenance marker.
  The rule belongs on the field it governs, where the next caller chooses.
