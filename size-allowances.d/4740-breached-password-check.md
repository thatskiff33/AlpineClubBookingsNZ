# File-size allowances for #4740 (#4610, breached-password check)

file: src/app/api/admin/lodge/route.ts
lines: 501
reason: the kiosk PUT and POST each gain the two-line breach screen
  (INV-AUTH-006) right before they hash the officer-chosen password, plus
  one import. The refusal response lives in breached-password.ts already;
  the screen itself has to stay in the handler, because the passwordHash
  writer census only accepts a guard in a block that encloses the write.
  Splitting the kiosk handlers out of this route is a refactor of its own.

file: src/lib/config-transfer/categories/club-settings.ts
lines: 1190
reason: the breachedPasswordCheck column joins the login-security
  singleton's field list and its required-field map, beside the policy
  fields it extends. Those two lists are one spec object; moving one
  setting elsewhere would split a single singleton's definition across
  files.
