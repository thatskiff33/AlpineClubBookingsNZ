# The symbols `migration.sql` names have moved

`migration.sql` in this directory says the rows it deletes match

> the benefit test the application now applies (`isBeneficialPromoAllocation` /
> `BENEFICIAL_PROMO_ALLOCATION_FILTER` **in `src/lib/promo.ts`**)

**That lockstep claim is still exactly true. Only the file path is stale.**

Since #3128 both symbols live in **`src/lib/promo-usage-counts.ts`**, which was
split out of `promo.ts` without changing either of them. The predicate, the
Prisma filter and this migration's `DELETE` remain the same rule expressed three
times, and `promo-zero-benefit-usage-caps.test.ts` still pins the SQL against the
TypeScript.

## Why `migration.sql` was not simply corrected

Prisma checksums the **contents of `migration.sql`**. Editing an
already-applied migration — even one character inside a comment — changes that
checksum and makes `prisma migrate deploy` fail on every environment that has
already run it. See `docs/BLUE_GREEN_MIGRATION_POLICY.md`.

So the file is deliberately byte-frozen, and the correction lives beside it
instead. A sibling file is safe: the checksum covers `migration.sql` alone, which
is why `rollback.sql` files already ship inside migration directories here.

## If you are changing the benefit rule

Change all three together, or the migration deletes rows the runtime counts, or
leaves rows it does not:

1. `isBeneficialPromoAllocation` — `src/lib/promo-usage-counts.ts`
2. `BENEFICIAL_PROMO_ALLOCATION_FILTER` — same file
3. the `DELETE` predicate in `migration.sql` here — **frozen**; a rule change
   needs a NEW migration, never an edit to this one

`src/lib/promo-usage-counts.ts` carries the other half of this note. If either
symbol moves again, update it there and here — `migration.sql` cannot follow.
