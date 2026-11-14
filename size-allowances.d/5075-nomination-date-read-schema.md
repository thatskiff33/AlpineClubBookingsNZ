# File-size allowances for #5075

The change adds a four-line comment to `isoDateSchema` in `src/lib/nomination.ts`
and changes no code in that file. The comment records why that one date check
stays shape-only while the finance metrics route moves to the real-day schema.

file: src/lib/nomination.ts
lines: 2653
reason: the comment has to sit on the `isoDateSchema` declaration it
  explains. That schema is the read side of already-stored application JSON,
  kept loose on purpose (#3082), and it looks exactly like the shape-only
  checks other changes convert to the real-day schema. A comment anywhere else
  would not stop the next reader converting it, and splitting a 2,600-line
  module for four comment lines is a refactor of its own.
