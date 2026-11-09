- **Deleting a member no longer deadlocks with that officer's own cash
  payments, review closures or change-request approvals (#4850).** If an
  officer's record was being permanently deleted while they were recording a
  cash payment, closing an edit review or approving a change request on a
  booking they had made, the two could wait on each other until the database
  cancelled one.

  The delete now locks those bookings first. If the delete finishes first, the
  officer's payment, review or approval is not recorded. If the officer's work finishes
  first, the delete goes ahead or is refused by its usual checks. If a booking
  starts naming the member, or a payment they recorded is being changed, while
  the delete is under way, the delete stops, saves nothing, and asks you to try
  again. Approving a policy exception or a booking request is brought into the
  same order separately (#4853, #4857); change requests already were (#4845).
