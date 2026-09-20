- **A finance officer can now withdraw an unpaid payment request that a
  financial review raised (#3528).** When a booking-edit review is completed as
  "ask the member to pay" and the figure turns out to be wrong, the request
  used to be stuck: the completed review could not be reopened, the member's
  booking page kept showing the amount with a pay button, and the only way to
  make it unpayable was the card provider's own dashboard, which left the
  amount showing as owing here. The booking page now offers **Withdraw payment
  request** to an admin with finance edit access, and asks before doing it.

  Withdrawing cancels the card request with the card provider first, then takes
  the amount off the booking and retires any Xero invoice that was waiting on
  that payment without sending it. The member no longer sees anything owing.
  If the system is still in the middle of setting the request up in the
  background, the withdrawal waits its turn and says so. The review that
  raised it stays completed, and the withdrawal is recorded in the booking's
  audit trail with who did it, how much, and which review it came from.

  Only a request raised by a financial review can be withdrawn, and only when
  it is the review's own money. A request that comes from a change to the
  booking's price is the price itself, and so is any part of a review's request
  that carried over an earlier price change — if the price is wrong, edit the
  booking, which replaces the request. A request the member
  has already paid is a refund, not a withdrawal, and is refused with a message
  saying so. If the card provider reports the payment as already made or still
  in progress, nothing is changed and the officer is told to check the booking.
