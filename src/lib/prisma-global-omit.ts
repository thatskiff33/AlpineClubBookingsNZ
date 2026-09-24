/**
 * The columns every application Prisma client OMITS by default (#2941, #3029,
 * `INV-PRIV-022`).
 *
 * `Member.dietaryRequirements` is special-category personal data (dietary and
 * allergy information, including children's). Omitting it at the CLIENT means a
 * broad `findMany()`, a nested `include: { member: true }`, a `tx.member.update()`
 * return value and every other default Member projection simply does not carry
 * it, so a new reader cannot leak it by forgetting a filter. The only opt-in is
 * an explicit `select: { dietaryRequirements: true }` inside
 * `src/lib/member-dietary.ts` or its booking write half
 * (`member-dietary-booking-writes.ts`), and `member-dietary-access-census.test.ts`
 * refuses one anywhere else, refuses a local `omit` override, refuses a raw-SQL
 * read of the column, and refuses an application `new PrismaClient(...)` that
 * does not pass this constant.
 *
 * Kept in its own dependency-free module so `src/lib/prisma.ts`,
 * `src/lib/audit-retention.ts` and the census can all import it without a cycle.
 */
export const PRISMA_CLIENT_GLOBAL_OMIT = {
  member: { dietaryRequirements: true },
  // #3029: the per-stay snapshot of the same data, omitted on the same terms —
  // every `include: { guests: true }`, every unselected guest read and every
  // guest row a create or update hands back arrives without it.
  bookingGuest: { dietaryRequirements: true },
} as const;
