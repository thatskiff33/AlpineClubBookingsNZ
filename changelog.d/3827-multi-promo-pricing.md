- **Several promo codes priced on one booking (#3827, epic #3813).** Once the
  **Several promo codes on one booking** module is switched on, a booking can
  carry more than one code — two members sharing a group booking can each use
  their own free nights. A night is discounted by one code only: each code
  covers just the nights no earlier code took, in the order the booker chose,
  and a working-bee discount always goes first. A code left with nothing to
  discount is refused as "already covered", and removing a guest removes only
  their code. Each code keeps its own usage limits. Booking, editing and
  previewing accept a list of codes (`promoCodes`); the single `promoCode`
  field still works, and an edit through it keeps a working-bee discount
  rather than dropping it. While the module is off, a second code — or a code
  beside a working-bee discount — is refused.

  **A deliberate tightening, for every booking:** a guest added from outside
  the booker's family who has **not yet accepted** their place now gets no
  promo discount — not even from a code typed at booking, which used to
  discount their nights too. When they accept, the booking's codes are applied
  again; on a paid booking the whole reduction goes back, with no
  cancellation-policy percentage, the way it was paid (card refund, bank
  transfer, or account credit), and the owner is emailed. If it cannot all go
  back that way the price is left for the next edit and the codes use nothing.
  A decline uses up nothing.
