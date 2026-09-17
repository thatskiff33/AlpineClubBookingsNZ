- **Groundwork: a school can now have a record of its own, though nothing uses
  it yet (#3366).** Nobody will notice a change from this release. It is the
  first of four steps towards fixing something the treasurer and the booking
  officer both live with today, and it is deliberately inert so it can be
  reviewed and released on its own.

  At the moment a school is not a thing the system knows about. When a school's
  booking request is approved, the system invents a member: the school's name
  goes in the first-name box, the surname is left blank, and the email is
  whoever sent the request. That invented person then owns the booking, holds
  the Xero contact, receives the invoices and is the name on every history
  entry. The real teacher becomes a second invented person. Because nothing
  anywhere says "this is a school", the club cannot hold a school's identity
  from one year to the next, cannot group its history in Xero, and cannot tell
  schools from people in a contact list — and Xero, which expects a person's
  name in a person's contact, is handed a surnameless one it cannot match.

  This release adds the records that identity will live in: a school record with
  its own name, contact details and its own Xero customer link, kept separate
  from any person's; and a way of listing the teachers and contacts who speak
  for it, while they stay ordinary people in the member list. A booking and a
  booking request can each point at a school.

  Nothing reads any of it yet, nothing writes to it, and the invented member is
  untouched — so every existing screen, email, invoice and report behaves
  exactly as it did. The step after this one makes the school the party the club
  invoices and corresponds with, and fixes the Xero contact problem.
