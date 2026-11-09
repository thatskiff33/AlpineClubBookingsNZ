- **Recording a cash payment no longer risks deadlocking with a member merge
  (#4840).** If an officer recorded a cash payment while their own duplicate
  record was being merged, and the booking named that duplicate, the two could
  wait on each other until the database cancelled one of them.

  The payment now locks its booking before it records who took the cash. If
  the merge finishes first, the payment is not recorded and the officer
  records it again from their surviving record.
