Allowances for #4581 (admin page areas aligned with their APIs).

file: src/lib/admin-permissions.ts
lines: 1019
reason: the route-area map is the single home of the page-to-area rule; the fix is one moved prefix, one new prefix and the comments that stop the next editor undoing them (the resolver is first-match-wins, so placement is load-bearing). Splitting the map is a separate refactor.

