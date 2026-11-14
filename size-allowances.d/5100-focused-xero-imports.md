file: src/lib/xero-api-client.ts
lines: 813
reason: The retired facade's server-only marker belongs at the transport used
  by all focused services. Splitting the transport is unrelated to replacing
  that guard and would widen this behavior-preserving import refactor.

file: src/lib/xero-operation-retry.ts
lines: 2237
reason: The existing lazy load now names the focused services instead of the
  retired facade. Keeping the retry's private service loader next to its one
  caller avoids creating another shared facade or changing retry timing.
