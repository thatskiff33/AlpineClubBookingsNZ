Allowances for #4581 (admin page areas aligned with their APIs).

file: src/lib/admin-permissions.ts
lines: 1019
reason: the route-area map is the single home of the page-to-area rule; the fix is one moved prefix, one new prefix and the comments that stop the next editor undoing them (the resolver is first-match-wins, so placement is load-bearing). Splitting the map is a separate refactor.

file: src/app/(admin)/admin/lodges/[id]/page.tsx
lines: 659
reason: the Lockers card gate and the guarded summary fetch must sit beside the card definition and its effect; extracting them would scatter one decision across files for nine lines.
