- **Deleting a member no longer deadlocks with that officer's own cash
  payments or review closures (#4850).** If an officer's record was being
  permanently deleted while they were recording a cash payment or closing an
  edit review on a booking they had made, the two could wait on each other until
  the database cancelled one.

  The delete now locks those bookings first. If the delete finishes first, the
  officer's payment or review is not recorded. If the officer's work finishes
  first, the delete goes ahead or is refused by its usual checks. If a booking
  starts naming the member, or a payment they recorded is being changed, while
  the delete is under way, the delete stops, saves nothing, and asks you to try
  again. Approving a change request, a policy exception or a booking request is
  brought into the same order separately (#4845, #4853, #4857).
