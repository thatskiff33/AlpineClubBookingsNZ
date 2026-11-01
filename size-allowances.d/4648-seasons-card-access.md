Allowances for #4643 (the lodge hub's Seasons & Rates card gated like Lockers).

file: src/app/(admin)/admin/lodges/[id]/page.tsx
lines: 664
reason: the card's two gates and the guarded season fetch must sit beside the card definition and the hub's single summary effect, as #4581's Lockers gate does; extracting them would split one decision across files for five lines.
