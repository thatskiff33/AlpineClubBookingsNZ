# Size allowances for #5096

function: src/components/stripe/BookingPaymentWrapper.tsx#BookingPaymentWrapper
lines: 355
reason: shows the server card charge and saved-credit outcome at the pay step;
  those lines sit inside the function `BookingPaymentWrapper`, which was
  already over its limit before this change, and lifting it apart is a
  refactor of its own, not part of this fix.
