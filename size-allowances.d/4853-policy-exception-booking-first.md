# File-size allowances for #4853

file: src/lib/booking-exception-execution.ts
lines: 1035
reason: the booking-row lock has to sit in the one approval engine between its lodge key and its claim, keyed from the store's pre-read; moving it out would hide the order that is the fix.
