# File-size allowances for #4611 (maximum session age)

file: src/lib/auth.ts
lines: 828
reason: the jwt callback is the one place every session refresh passes
  through, so the cap's call has to sit in it, beside the revocation rule
  whose sessionInvalidated flag it sets: the incoming-stamp capture before
  the back-fill, the settings read beside the module-flag read, and the
  call. The rule itself lives in session-max-age.ts; only the wiring is
  here. Splitting the jwt callback out of auth.ts is a refactor of its own.

file: src/lib/config-transfer/categories/club-settings.ts
lines: 1195
reason: the sessionMaxAgeHours column joins the login-security singleton's
  field list and its required-field map, beside the policy fields it
  extends. Those two lists are one spec object; moving one setting
  elsewhere would split a single singleton's definition across files.
