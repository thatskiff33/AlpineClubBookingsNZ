### Changed

- A school booked with the club is now recorded as a school, and it is the party
  the invoice belongs to. Approving a school request creates the school's own
  record, attaches the booking and the request to it, and records the real
  teacher against it — instead of leaving the school to be represented by an
  invented person with no surname. In Xero the school now appears as an
  organisation, with the teacher named on it as a contact person, so the
  treasurer can see who to talk to without leaving Xero
  ([#3367](https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/3367),
  stage 2 of [#2912](https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/2912)).
- The teacher named on a school's Xero contact is kept honest: it is refreshed
  the next time the club raises anything against that school, which in practice
  means the school's next approval. Nothing is sent when nothing has changed, and
  the school's name in Xero is never rewritten.
- A school that booked before this change keeps the very same Xero contact, and
  the school's own record takes it over the next time the club raises something
  against it. Nothing changes in Xero — the contact keeps its id, its history and
  every invoice already on it — and the hand-over is recorded in the audit log.
- A booking that is not a school's is unaffected in every respect.

### Fixed

- A Xero customer can no longer end up claimed by two different local records at
  once. Every path that links one now refuses, and says which record already
  holds it, rather than leaving the club with a school and a person pointing at
  one customer in its accounts. The single exception is a school taking over the
  contact that was created for it under its own name, which is recorded in the
  audit log.
