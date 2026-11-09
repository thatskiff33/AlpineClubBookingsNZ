- **A cancellation no longer refunds a superseded card payment's money as the
  booking's own (#4866).** When a member paid a card request the app had
  already replaced, the app refunds that payment in full on its own. If the
  booking was cancelled before that refund went out, the cancellation could
  refund part of the same card charge for the booking, and the superseded
  payment's refund then sent only what was left: the member got back less than
  they were owed, and no officer was told. Where the booking's own payments did
  not reach its price, the cancellation policy was also applied to the
  superseded payment as if it had been paid for the booking. A cancellation now
  leaves that payment to its own refund: it is not counted as paid for the
  booking, and the cancellation's card refund comes from the booking's other
  card payments. The cancellation preview shows the same figures.
