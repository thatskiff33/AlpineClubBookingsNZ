# File-size allowances for #2975 / #2984

The code change here is a one-line condition. What grew the file is the
explanation of it: `hasAdminPortalAccess` used to exclude `finance`, and that
exclusion had already been read three separate ways by three separate pieces of
work — as a deliberate boundary (`admin-lodges-access-gate.test.ts`), as a
shipped preset's known defect (#2925), and as an outright contradiction with
`getFirstAccessibleAdminHref` twenty lines below it. A reader who does not know
which of those was true will re-litigate it, so the docblock says what standing
is, what it is NOT, which three callers may ask the question, and where the
negative half is proved.

Splitting is available in principle here — the route map, the matrix resolution
and the derived-access helpers are three separable concerns — but it is a
refactor of a security-critical module with about eighty importers, and doing it
underneath a privilege-model correction would put the change and the move in one
diff and make the diff unreviewable. Left as a debt to pay on its own change.

file: src/lib/admin-permissions.ts
lines: 822
reason: the privilege-model correction is one condition; the growth is the
  docblock that stops the next reader restoring the exclusion, which three
  earlier pieces of work each recorded differently. Splitting this module is
  worth doing and must not ride along with a security change.
