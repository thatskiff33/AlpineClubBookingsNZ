# File-size allowances for #4840

file: src/lib/payment-reconciliation.ts
lines: 2886
reason: the manual settle's booking-row lock has to sit inside the one settlement body, between its lodge key and its Payment attribution write; moving it to another module would hide the order that is the fix.
