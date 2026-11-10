# File-size allowances for #4616

file: src/lib/auth.ts
lines: 868
reason: the recent-authentication stamp is written by the jwt callback's
  sign-in branch and by its session-update branch, beside the two-factor
  challenge consume it mirrors, and projected by the session callback; those
  callbacks are this file. Moving the update handling out would also move
  the existing two-factor branch that #4617 and #4618 edit on the same epic
  branch, turning three small additive diffs into a conflict.
