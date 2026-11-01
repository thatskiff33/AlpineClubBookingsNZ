- **An edit's Xero note no longer records a bank refund before it is paid
  back (#4315).** The edit's refund task must be marked paid back before its
  note counts towards refunded cash, including when a later Xero sync recounts
  the payment. A dismissed task records no refund. Cancellation card notes
  now explicitly carry the card method through processing and retries.
