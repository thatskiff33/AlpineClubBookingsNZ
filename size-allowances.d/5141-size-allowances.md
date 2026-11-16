# Size allowances for #5141

file: src/app/(admin)/admin/booking-desk/waitlist/page.tsx
lines: 1024
reason: imports the shared email retry ceiling into the waitlist page label
  instead of printing a literal; those lines sit inside this file, which was
  already over its limit before this change, and lifting it apart is a
  refactor of its own, not part of this fix.
