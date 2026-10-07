- **Every booking made before the booking ledger existed can now be given its
  ledger lines, so the ledger can be proved against the club's whole history
  (#3583).** `pnpm run booking-ledger:back-post` records each past booking's
  price, payments, account credit, refunds, change fees, edits and
  cancellation in the ledger, using the same rules that record a new booking
  today. It shows what it would record before it records anything, records
  each booking on its own, and records nothing new when run a second time.
  It checks every booking against the ledger census as it goes. Where a
  booking's figures would not agree, it records nothing for that booking and
  lists it with the reason and both figures for an officer to look at. It
  never estimates a figure, never changes an existing entry, and contacts no
  payment or accounting provider. The ledger is still not used for anything a
  member or officer sees; the owner's step-by-step run is in the maintenance
  guide, and the same sequence now runs on every change against a test
  history.
