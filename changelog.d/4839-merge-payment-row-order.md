- **Merging two member records no longer risks deadlocking with a card payment
  on the same booking (#4823).** When the duplicate had recorded a cash payment
  as an officer, the merge updated that payment while it held the booking. A
  card payment arriving for the same booking at the same moment could then wait
  on the merge while the merge waited on it, and the database cancelled one of
  them.

  The merge now updates those payments last and never waits for one. If another
  change is using one of them at that moment, the merge stops, saves nothing,
  and asks you to try again a moment later. Card payments, refunds and appeals
  are unaffected.
