- **Failed emails can be tried again, and link to their booking and member
  (#4963).** On **Email Deliverability**, an email that used up its automatic
  retries could only be archived. A row that still holds a copy of its message
  now has **Try again**: it goes back to the email retry job, which sends it on
  its next run after re-checking suppressions, the booking's **No emails**
  switch and the booking link. Nothing is sent from the button itself.

  Rows that keep no copy (booking confirmations, door-code reminders, payment
  and sign-in links) now say why they cannot be resent and link to the booking
  or member so an officer can send a fresh message. A new **Total exhausted**
  figure counts every exhausted failure, and a note appears when the list shows
  only the newest 200.
