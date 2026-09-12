# File-size allowances for #3367 (stage 2 of programme #2912)

Three already-over-budget files grow here, and one new module was split rather
than allowed — `organisation-xero-contacts.ts` came in at 859 lines, so its
contact-person half moved to `organisation-xero-contact-persons.ts` and both
halves now sit inside the budget. The three below are cases where the split is
genuinely the worse answer.

file: src/lib/school-booking-request.ts
lines: 2658
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
lines: 1908
reason: Three lines net. The member payload builder's object literal MOVED OUT
  to `xero-contact-shape.ts`, which the organisation builder shares, so the
  single-source-of-truth direction of this change is a reduction. What is added
  back is the two-homes refusal in phase 2 — four statements and the comment
  explaining why a school's contact can otherwise be linked to a member
  deterministically rather than by a race — plus two export keywords and their
  docblocks, so the organisation path can share this module's name search and
  duplicate-name predicate rather than copying them.

file: src/lib/xero-booking-invoices.ts
lines: 1410
reason: Six lines, and five of them are the comment. One call site changes from
  `findOrCreateXeroContact(booking.memberId, …)` to
  `findOrCreateXeroContactForInvoicedParty(booking, …)`. The comment is there
  because the whole of "the organisation becomes the invoiced party" is that one
  line — an invoice payload sends a contact reference and no name — and a reader
  who does not know that will go looking for a change in the eleven invoice
  builders that is not there.
