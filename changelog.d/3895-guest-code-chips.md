- **A booker can now use their guests' promo codes, and several codes at
  once (#3492, epic #3813).** On the booking review step, the booking edit
  panel and Admin → Book on Behalf, each guest member's assigned promo codes
  appear as chips grouped under that guest's name and marked "applies to
  *name* only", beside the booker's own. Nothing is applied until the booker
  presses a chip or types a code. With the **Several promo codes on one
  booking** module on, the booker can apply more than one code and use
  **Move earlier** / **Move later** to set their order — where two codes could
  cover the same night, the earlier one does — and the summary shows one line
  per code. With the module off, a booking still takes one code.

  Only a family guest's codes, or those of a guest from outside the family who
  has already accepted their place, are ever offered; a pending or declined
  guest never shows a chip. The booker sees only each code and what it gives.
  Every lookup is recorded in the audit log as `promo_code.guest_lookup`
  (category privacy) and is limited to 30 a quarter-hour per member.
