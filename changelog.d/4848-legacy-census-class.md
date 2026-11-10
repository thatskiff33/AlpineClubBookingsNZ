- **The booking-ledger census now names an old late card charge the same way
  as one that already has a type (#4848).** Charges raised before 19 August
  2026 have no type. `pnpm run booking-ledger:census` only recognised a
  completed late charge that already had the type, so an older one on a
  deleted booking was an unexplained difference. It is now named
  `V3_LEGACY_HAND_BACK` when its wording is one of the frozen late-charge
  sentences, the same rule the refund check uses. A cancellation refund on a
  booking deleted later is still not that class. The census reads only; no
  money moves. A booking this newly names still needs the same sign-off as
  the other old late charges before the ledger switch-over.
