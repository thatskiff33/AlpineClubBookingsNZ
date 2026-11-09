# File-size allowances for #4850

file: src/lib/member-lifecycle-actions.ts
lines: 1771
reason: the booking-row lock and its re-check must sit around the Member-row fence inside the hard-delete transaction; the lock itself lives in member-delete-booking-rows.ts, and moving the calls out would hide the order that is the fix.
