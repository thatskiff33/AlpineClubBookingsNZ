# File-size allowance for #4280 - the reversal floor keeps Paid another way bank cash

file: src/lib/payment-transactions.ts
lines: 1714
reason: one import, one input to the floor's shared helper, and the docblock
  the floor carries saying why the close's cash is read payment-wide and on
  the writer's own client. The floor (`reversalFloorForTransaction`) is private
  to the one card-refund writer (`INV-PAY-103`) and runs under its Payment row
  lock, so it stays beside that writer; the new reader itself lives in
  `card-refund-paid-another-way-cash.ts`, with the other readers of a close's
  bank cash, so this file gains only the call site.
