- **Groundwork for several promo codes on one booking (#3826, epic #3813).**
  The database can now hold one promo redemption per code on a booking, and
  a night can still never be discounted twice — that is now enforced by the
  database itself. Nothing members or officers see changes yet: every
  single-code price, email and Xero invoice is exactly as before.

  A new module switch, **Several promo codes on one booking**, ships **off**.
  While it is off, a booking can hold at most one code, which keeps the
  previous release safe to roll back to during the upgrade. Leave it off until
  the upgrade has fully cut over; the release that lets members pick several
  codes will say when to turn it on.
