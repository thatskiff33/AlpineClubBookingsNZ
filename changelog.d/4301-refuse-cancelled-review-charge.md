- **A booking-change review can no longer ask a cancelled booking's member to
  pay (#4272).** When an officer settled a booking-change review as money owed
  to the club after the booking had been cancelled, and the booking still held
  money paid by card, the system created a card payment request the member
  could never pay: every place a member pays leaves cancelled bookings out.
  The task still read as completed, so the treasurer saw a charge that would
  never be collected.

  The officer now sees a clear refusal instead, and the task stays open:
  collect the amount another way, then dismiss the task with a note recording
  what was collected and how. If the organiser paid for a joiner's booking,
  the message says to agree the amount with the organiser.

  If the booking is cancelled in the moment just after a review is settled,
  nothing is asked of the member and the officer is told so straight away. The
  amount still owed is recorded once in the audit log as a review share that
  was not collected: the settled total less anything the member paid towards
  it and kept, with any refund stated, and it waits while that payment or a
  refund of it is still going through. An officer can find it there and
  collect it another way. Reviews on bookings that are not cancelled are
  unchanged.
