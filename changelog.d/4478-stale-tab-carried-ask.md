- **A member can no longer pay the same extra charge twice from an old browser tab (#4442).**
  When a member changed a booking again while an earlier extra card charge was
  still unpaid, the new charge included the earlier one's balance and cancelled
  it. If an old tab paid the earlier charge in the moment while the new charge
  was being set up, that payment was kept and the new charge still asked for
  the same money, so the member paid it twice and nobody was told. The new
  charge is now checked against what is still unpaid just before it is saved:
  if the earlier charge was paid in that moment, the new charge is not offered,
  and the automatic retry asks only for the latest change. A legacy retry
  whose saved amount cannot be reconstructed refuses after an earlier extra
  charge was captured, and alerts an officer when its attempts run out. This closes the
  short window #4422 left open.
