# File-size allowances for #5036

file: src/app/(authenticated)/book/_hooks/use-booking-wizard.ts
lines: 2397
reason: the lockout mode has to be read once, beside the subscription status the
  hook already owns, so the banner's fact and the dates step's consequence come
  from one place (#4941). Moving those thirteen lines out would re-create the
  two-readers split this change removes.
