# File-size allowance for the booking wizard's network-failure handling (#4942)

file: src/app/(authenticated)/book/_hooks/use-booking-wizard.ts
lines: 2384
reason: the four handlers that post from the wizard (quote, create, join
  waitlist, save draft) each gain a try/catch/finally so a dropped connection
  or a gateway error page can no longer freeze their button. The catches and
  their "could not verify" copy have to stay in this file: the #2668 contract
  walk reads one file at a time, so moving them behind an imported helper
  would take the wizard out of its reach. The body reader that can move did
  move, to `_lib/read-json-or-null.ts`. Splitting the hook is its own refactor.
