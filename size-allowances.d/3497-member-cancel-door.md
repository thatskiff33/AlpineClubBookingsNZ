# File-size allowances for #3497

One already-over-budget file grows. The cancellable status lists themselves
LEFT this file for `src/lib/booking-cancel-eligibility.ts`; what remains is the
member-door opt-in the cancel route passes, sitting beside the started-stay
opt-in it mirrors, and the guard that honours it.

file: src/lib/booking-cancel.ts
lines: 2506
reason: `enforceMemberCancelDoor` is a second opt-in of exactly the shape of
  `enforceStartedStayBlock` — an option, a positional parameter, and one guard
  inside `performBookingCancellation` that must run after the authorization
  gate and before the service-wide status gate so a stranger learns nothing
  and a member gets the right sentence. That ordering is only reviewable in
  the function that holds the other gates; the lists it reads already live in
  their own leaf module.
