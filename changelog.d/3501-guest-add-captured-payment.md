- **Adding a guest to a booking that has had a refund now collects the extra
  money (#3244).** If a member had a partial refund on their booking — someone
  dropped out, or a night came off and money went back — and a guest was then
  added, the club collected nothing for that guest. No error appeared and
  nothing was logged; the charge simply never happened, and the shortfall landed
  on the club.

  The cause was that this one screen decided "has this booking been paid?"
  differently from every other way of editing a booking. The other three treat a
  part-refunded booking as paid, because the money did go through that card and
  it is still the right place to collect from. This one treated it as never
  paid. All four now ask the same question in the same place, so the difference
  is charged to the original card exactly as it is everywhere else.

  **What an officer will notice:** a member adding a guest to a part-refunded
  booking is now asked to pay the difference, where before they were not.
  Nothing about how the amount is worked out has changed — only whether it is
  asked for at all.

  One related correction comes with it. A booking that ended up costing nothing
  — where credit or a discount covered the whole stay — was being treated here
  as though it had a card on file to charge, even though no card payment exists
  for it. It no longer is, which matches what every other edit screen has always
  done.
