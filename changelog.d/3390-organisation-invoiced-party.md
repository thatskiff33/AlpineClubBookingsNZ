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
- The teacher named on a school's Xero contact is kept honest: approving a
  booking makes that booking's teachers the school's current contact people, so
  a teacher who has left stops being named, and the contact is refreshed the
  next time the club raises anything against that school. Nothing is sent when
  nothing has changed, and the school's name in Xero is never rewritten. A
  school's own email address and phone number are a separate matter: they are
  recorded the first time the school is created and are not changed by a later
  booking, so correcting one is still done in Xero for now.
- A school that booked before this change keeps the very same Xero contact, and
  the school's own record takes it over the next time the club raises something
  against it. Nothing changes in Xero — the contact keeps its id, its history and
  every invoice already on it — and the hand-over is recorded in the audit log.
  The contact also stops being shown as a person at that point: the invented
  first name and blank surname are cleared, so it reads as the school it is.
  A school is recognised as the same school even where its name was typed
  differently the second time — a full stop dropped, a hyphen added, a macron
  written or left off — because that is exactly how Xero itself matched the
  contact back to the school in the first place.
- A booking that is not a school's is unaffected in every respect.

### Fixed

- A Xero customer can no longer end up claimed by two different local records at
  once. Every path that links one now refuses, and says which record already
  holds it, rather than leaving the club with a school and a person pointing at
  one customer in its accounts — including importing a Xero contact as a member,
  where a school's contact can now appear in the list of contacts to import. The
  single exception is a school taking over the contact that was created for it
  under its own name, which is recorded in the audit log.
- A school's invoice can no longer be raised against one of its teachers by
  accident. Where a school records a teacher's own address as its contact
  address, an invoice that had to retry used to be able to resolve that
  teacher's personal Xero contact and bill them; it now always resolves the
  school.
- A failed Xero contact operation for a school can be retried from the admin
  screen. It previously reported that retries "require a member-local record"
  for exactly the operations that are meant to be replayable.
