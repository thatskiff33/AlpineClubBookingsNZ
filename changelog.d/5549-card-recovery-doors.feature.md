- **A member who pays by card is now sent Booking Confirmed in three cases
  that sent nothing before (#5433).** The first two are a card payment whose
  notice from Stripe did not reach the app, found when the member returns to
  the pay step or when the payment link is used again. The third is a saved
  card charged by an officer, or by a scheduled call set up to do so, to pay a
  confirmed booking (owner decision). In each case the booking was marked paid
  and the member heard nothing; when Stripe's notice did arrive later it found
  the booking already paid and sent nothing either.

  These confirmations follow the same rules as every other card payment since
  #5471: if the app is interrupted after the payment is saved, the email goes
  on a later run, usually within an hour, and officers get "Booking
  confirmation not sent" if it cannot get through. No member is sent it twice.

  What officers notice: a member now receives an email after an officer charges
  their saved card, where that used to be silent.
