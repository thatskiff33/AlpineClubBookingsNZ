- **Import the future bookings a club has already been paid for (#5005).**
  A club moving in from another booking system can now bring across its paid
  future stays from one CSV, under Admin → Bookings → **Import Paid Bookings**.
  Each booking is stored as paid at the amount the member actually paid, holds
  its beds and is placed by the normal bed allocation. No Xero invoice, card
  payment request or email is made, because the money is already in the club's
  accounts.

  The preview writes nothing. It refuses, with a plain reason, any booking that
  cannot import (a member not matched, a night that would go over capacity, a
  member already booked that night, a stay that breaks the club's hosting rule),
  and shows totals of bookings, guests, guest-nights and dollars for the
  imported and refused rows, and the beds booked each night, to check against
  the old system's report. Uploading the same file again never creates a
  booking twice. A batch can be reversed: bookings nobody has touched since the
  import are cancelled with their recorded payment taken back and nobody
  emailed; touched bookings are kept and named. Importing and reversing need an
  officer holding both finance edit and bookings edit. A cancelled imported
  booking's refund is paid back by hand, as for any cash booking. Part-paid
  bookings are refused for now. See
  [Moving in, step 7](../docs/guides/moving-in.md#7-future-bookings-import-prepaid-stays).
