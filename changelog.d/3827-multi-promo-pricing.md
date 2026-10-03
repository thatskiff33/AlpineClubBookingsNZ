- **Several promo codes priced on one booking (#3827, epic #3813).** Once the
  **Several promo codes on one booking** module is switched on, a booking can
  carry more than one code — two members sharing a group booking can each use
  their own free nights. A night is discounted by one code only: each code
  covers just the nights no earlier code took, in the order the booker chose,
  and a working-bee discount always goes first. A code left with nothing to
  discount is refused as "already covered", and removing a guest removes only
  their code. Each code keeps its own usage limits. Booking, editing and
  previewing accept a list of codes (`promoCodes`); the single `promoCode`
  field still works; with the module on, an edit through it keeps a
  working-bee discount rather than dropping it. While the module is off,
  nothing changes for a single-code club: a second code is refused, and a code
  entered on a booking with a working-bee discount replaces it as before.

  **A deliberate tightening, for every booking:** a guest added from outside
  the booker's family who has **not yet accepted** their place now gets no
  promo discount — not even from a code typed at booking, which used to
  discount their nights too. When they accept, the booking's codes are applied
  again; on a paid booking the whole reduction goes back, with no
  cancellation-policy percentage, the way it was paid (the card or bank
  transfer first, then account credit for any part paid with credit), and the
  owner is emailed. If it cannot all go
  back that way the price is left for the next edit and the codes use nothing.
  A decline uses up nothing.

- **Internet-banking refunds on a booking change now ask the treasurer to send
  them (#3827, owner decision D-3813-6). A behaviour change for every club.**
  Until now, when a change lowered the price of a booking paid by internet
  banking or in cash, the app recorded a refund, raised the Xero credit note
  and emailed the member that the refund "has been processed" — but asked
  nobody to send the money. Now the change raises a task in **Money to settle**
  on the Payments page for the refund amount (one per change), the member's
  email says the club **will** refund them by bank transfer, and marking the
  task paid back records the refund. The Xero credit note is unchanged. Card
  refunds are unaffected. While such a task is open its amount counts as
  already promised back: a later change, a cancellation or a refund appeal
  (asked or approved) can return only what is left. Once the booking is
  cancelled the task can only be marked paid back — it cannot be dismissed,
  and a dismissed one cannot be reopened.

- **Approved refund appeals on internet-banking bookings now ask the
  treasurer to send the money (#3827, owner decision D-3813-7). A behaviour
  change for every club.** Until now, approving an appeal on a booking paid
  by internet banking queued a Xero credit note but never recorded the refund
  on the payment or asked anybody to send it, so a second appeal could be
  approved against the same money. Now the approval raises one task in
  **Money to settle** for the amount no card refund can carry, the member's
  email says the club **will** refund them by bank transfer, and marking the
  task paid back records the refund. Until then the amount counts as already
  promised, so a further appeal can be approved only for what is left. Card
  appeals are unaffected.

  **Deploy note:** do not mark these refund tasks (the edit ones above, or
  the appeal ones) paid back until cutover
  completes. The previous version would also queue a second Xero refund
  credit note (`docs/UPGRADING.md`).
