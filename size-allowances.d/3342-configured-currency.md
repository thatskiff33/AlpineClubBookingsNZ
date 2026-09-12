# File-size allowance for PR #3342 (#3325, the configured currency everywhere)

One already-oversized component grows by exactly one line, for the same reason
#3326 recorded for four files: a hard-coded currency folded into the club's
configuration. Nothing else in the file moved.

file: src/components/admin/booking-requests/public-booking-requests-panel.tsx
lines: 2240
reason: the "Total (NZD)" price label now renders the configured currency
  code, `Total ({APP_CURRENCY})`. +1 line (the import); the label edit itself
  nets to the same count.
