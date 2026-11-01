# File-size allowance for #4609

The per-account password throttle lives in `src/lib/login-throttle.ts`; what
`auth.ts` gains is only its wiring into the Credentials `authorize` callback —
the claim before the member lookup, the throttled error class, one shared
dummy-compare helper for both refusal branches, and the clear on a valid
password. The #3186 allowance that took this file to 829 has merged and is
inert, so this change declares its own; the file stays under that old figure.

file: src/lib/auth.ts
lines: 826
reason: the claim has to sit inside `authorize`, before the member lookup,
  because the enumeration-parity rule (INV-AUTH-002) is about the order of
  those statements; moving the throttle logic out already left only the calls,
  and splitting NextAuth's provider configuration to save twenty lines would
  separate the throttle from the lookup it must precede.
