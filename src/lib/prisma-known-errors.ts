import { Prisma } from "@prisma/client";

/**
 * A unique-constraint failure (`P2002`) that Prisma itself raised: an instance
 * of `Prisma.PrismaClientKnownRequestError` whose `code` is `P2002` (#5407 item
 * 6). The one spelling of that test.
 *
 * Narrower than `isPrismaUniqueConstraintError` in `prisma-errors.ts`, which
 * accepts any object carrying the code (a test double, an error that crossed a
 * module boundary). A site that asked for the class keeps asking for it here,
 * so it catches exactly what it caught before. This lives in its own module
 * because it needs the Prisma runtime class, and `prisma-errors.ts` imports
 * nothing.
 *
 * Sites that also need WHICH constraint collided call this for the class and
 * code, then read the constraint themselves (`describeUniqueConstraintTarget`
 * in `prisma-errors.ts`, or their own reader). `prisma-p2002-census.test.ts`
 * fails on a `P2002` comparison written anywhere outside the two modules.
 *
 * The guard narrows to the class with that code only, so a `false` answer
 * leaves a value already known to be a `PrismaClientKnownRequestError` typed as
 * one (it may carry another code).
 */
export function isPrismaKnownUniqueConstraintError(
  error: unknown,
): error is Prisma.PrismaClientKnownRequestError & { code: "P2002" } {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}
