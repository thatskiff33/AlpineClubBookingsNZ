- **Edit reviews and "Paid another way" no longer spend a superseded card
  payment's money (#4879).** When a replaced card payment is captured anyway,
  the app queues its own refund for that charge. Completing an edit's financial
  review by card refund, or marking a different failed card refund as paid
  another way, could take part of the same charge first, leaving that refund
  short. Both now leave the charge to its own refund. A review that only fitted
  by using that money is refused and stays open. Marking the superseded refund
  itself as paid another way still records the payment against its own charge.
