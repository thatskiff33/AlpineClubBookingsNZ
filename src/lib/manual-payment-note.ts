/**
 * How long a hand-written money note may be — the ONE definition, on the side of
 * the boundary every caller can reach (`INV-SSOT`, #3498 fix round).
 *
 * ## Why it is its own file
 *
 * The width belongs beside `normaliseManualPaymentNote`, which trims to it, and
 * that lives in `manual-subscription-payment.ts` — a `server-only` module. So
 * every SCREEN that has to stop a person typing past it copied the number
 * instead, and there were five: the subscription manual-payment dialog, the
 * booking manual-payment controls, the stored-night-price controls, the finance
 * settlement queue, and the reopen card. Three carried a comment saying they
 * mirrored the server constant; two carried nothing at all.
 *
 * A number five places have to agree on is a number five places can disagree
 * on, and the disagreement is silent: `maxLength` on a textarea does not refuse,
 * it TRUNCATES. On the reopen note that matters more than anywhere else the copy
 * appears — the note is REQUIRED, and it is the only record of why a money
 * decision was undone.
 *
 * So the width moved HERE, a module with no imports at all and therefore no
 * side of the boundary: `manual-subscription-payment.ts` re-exports it, so every
 * server caller is unchanged, and the screens import it directly. Annotating a
 * sixth copy was the alternative, and a comment is not a dependency.
 *
 * It is also the database's rule, not a preference: the columns these notes land
 * in are `@db.VarChar(500)`.
 */
export const MANUAL_PAYMENT_NOTE_MAX = 500;
