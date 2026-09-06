- **A card charge that was already under way when this release goes out is now
  recognised and finished properly.** Such a charge was recorded in the older
  style, without the per-attempt reference this release introduces. If the
  member had since saved a different card, the system would not have recognised
  that earlier charge as this booking's money, and could have charged the new
  card alongside it. It is now recognised by what it was for, whichever card it
  names: closed and cancelled where that is still possible, and waited for where
  it is already going through at the card network. This applies to all three
  ways a saved card is charged, and it stops mattering once the charges that
  were open at the changeover have finished.
