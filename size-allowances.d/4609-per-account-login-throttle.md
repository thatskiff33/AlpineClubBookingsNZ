# File-size allowance for #4609

The per-account password throttle lives in `src/lib/login-throttle.ts`; what
`auth.ts` gains is only its wiring into the Credentials `authorize` callback —
the claim before the member lookup, the throttled error class, one shared
dummy-compare helper for both refusal branches, and the clear on a valid
password. The #3186 allowance that took this file to 829 has merged and is
inert, so this change declares its own; the file stays under that old figure.

file: src/instrumentation.node.ts
lines: 1725
reason: the idle login-throttle sweep joins the existing daily data-pruning
  job as one more isolated step beside the token sweeps it resembles, so the
  retention row's bound holds even in a process that handles no sign-ins;
  moving the scheduler out to make room for five lines is a refactor of its own.
