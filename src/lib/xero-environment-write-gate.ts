/**
 * The one gate that stops an UNDECLARED installation writing anything into the
 * club's Xero organisation (ENV-SAFETY 3, #3036; epic #2986). INV-CONFIG-005.
 *
 * ## Why this exists as well as the contact funnel
 *
 * `xero-contact-containment.ts` asks the environment role at the three
 * email-carrying contact writers, and `findOrCreateXeroContact` is the funnel
 * every Xero DOCUMENT writer goes through to obtain a contact — so an undeclared
 * installation could not raise an invoice or a credit note through those paths.
 * A review of this issue then found that "nothing is written to Xero at all",
 * which seven surfaces of this product asserted, was simply false. Writers that
 * never touch the funnel went on writing to the club's real accounting on an
 * installation nobody had declared:
 *
 * - a membership-cancellation credit note, which resolves its contact from the
 *   invoice it is crediting rather than from the funnel;
 * - contact-group membership, added and removed from `/api/profile`, the
 *   family-details route and the admin member service;
 * - archiving a contact on cancellation;
 * - voiding an invoice for a cancelled group settlement;
 * - recording a payment or a refund payment against an invoice;
 * - deallocating applied credit, which RAISES an invoice's amount due;
 * - updating a booking invoice's line items.
 *
 * A census of those call sites would have closed the ones that exist today. This
 * closes the one somebody writes next month too, which is the difference between
 * a list and a gate — the same argument `INV-CONFIG-004` made for putting the
 * delivery boundary inside `sendEmail` rather than at eighty-seven callers.
 *
 * ## What it refuses, and what it deliberately does not
 *
 * It refuses **mutations** while the role is UNKNOWN. It allows **reads**, and
 * that is a decision rather than an oversight: a read changes nothing in the
 * club's books and cannot make Xero email anybody, while an operator diagnosing
 * "why has this installation stopped writing to Xero" needs the Xero screens in
 * this application to keep loading. So the refusal is precisely the set of
 * operations that could leave a mark, and the operator copy says "written",
 * never "reached".
 *
 * ## Fail-closed classification
 *
 * {@link isXeroProviderMutation} treats an operation as a mutation unless its
 * name begins with `get`. That direction matters. An allowlist of known write
 * verbs would let `postInvoices`, `putContact` or a misspelled `createInvoicez`
 * through silently, and "the census can only see the writers that exist today"
 * is the failure this module exists to avoid repeating one layer down. Every
 * operation name in this repository follows the Xero SDK's own convention —
 * `getX` reads, `createX`/`updateX`/`deleteX`/`emailInvoice` write — and
 * `xero-write-gate-census.test.ts` pins that so a `list`-prefixed reader cannot
 * appear and be refused in production without a test noticing.
 *
 * ## Where it runs
 *
 * Inside `callXeroApi`, before `withXeroRetry` and before any usage row is
 * recorded: nothing was attempted, so nothing is metered. It is not a substitute
 * for the entry-point refusals — those still come first, so an undeclared
 * installation refuses before it has reserved an operation or taken a lock, and
 * nothing is left half-written. This is the backstop underneath them.
 *
 * ## A LEAF, on purpose
 *
 * It imports the role resolver and nothing else. `callXeroApi` lives in
 * `xero-api-client.ts`, which `xero-contact-containment.ts` imports — so the
 * gate cannot live in the containment module without a cycle. Keeping the shared
 * error class and the refusal wording here means there is still exactly ONE of
 * each.
 */

import {
  resolveEnvironmentRole,
  type EnvironmentRoleResolution,
} from "@/lib/environment-role";

/**
 * Thrown when nothing has declared which installation this is.
 *
 * Named, and distinct from a containment failure, because the repairs are
 * different: this one is a missing or unreadable configuration and its remedy is
 * on the operator's screen, while a containment failure is a provider problem.
 * The message carries the role resolver's own notes verbatim — those are written
 * to be read by an operator, name `APP_ENVIRONMENT_ROLE` and the override
 * screen, and never carry a credential.
 *
 * The name is `XeroContact…` for history rather than for scope: it was minted by
 * the contact gate and is now thrown by every Xero write. Renaming it would
 * churn the operator-facing string and every test that keys on it for no gain —
 * and note that the OUTBOX now keys on this name too, which the previous version
 * of this sentence claimed as a reason before it was true.
 *
 * ## `preHttp` IS THE LOAD-BEARING PART
 *
 * This refusal is raised before `fn()` runs, so nothing reached Xero — provably,
 * because the gate sits ahead of `withXeroRetry` and ahead of the usage meter.
 * The outbox decides whether a FAILED operation may be returned to PENDING by
 * asking exactly that question (`isXeroCooldownRefusal` in
 * `xero-operation-outbox.ts`, keyed on `error.name` plus `preHttp === true`), so
 * without the marker a refusal took the ordinary failure path — and twelve of
 * fifteen handlers have already written `status: FAILED` by then. That is the
 * outbox's own recorded defect, "a pile of FAILED-unattempted invoices that
 * NOTHING auto-recovers" (#2423 F2), reached through the very gate added to
 * prevent unattempted writes.
 *
 * The sharpest trigger is a declared-PRODUCTION site rather than an undeclared
 * one: one failed `environmentSafetySettings.findUnique` — a pool timeout during
 * a blue/green overlap — resolves UNKNOWN for an instant and would otherwise
 * condemn a whole in-flight cron batch to hand requeues.
 *
 * It is `readonly` and always `true`: unlike `XeroDailyLimitError`, which has a
 * post-HTTP construction site too, there is no way to raise this one after a
 * request has gone out. If that ever changes, this is the field to make a
 * constructor argument.
 */
export class XeroContactEnvironmentUnknownError extends Error {
  /** See the class docblock: this refusal always precedes the request. */
  readonly preHttp = true;

  constructor(message: string) {
    super(message);
    this.name = "XeroContactEnvironmentUnknownError";
  }
}

/**
 * The operator-facing refusal for an unconfirmed installation.
 *
 * It says what did NOT happen and why that is the safe direction, then hands
 * over to the resolver's own notes for the repair. Written this way because the
 * two obvious short messages are both actively misleading: "this installation is
 * not production" invites somebody to declare it production, and "Xero is not
 * configured" sends them to the Xero screens, where nothing is wrong.
 */
export function describeXeroContactEmailRefusal(
  resolution: EnvironmentRoleResolution,
): string {
  return [
    "Nothing was written to Xero: this application cannot tell whether it is " +
      "the club's live site or a copy of it, and the answer decides what may " +
      "reach the club's accounting. The sharpest case is the email address on a " +
      "Xero contact — on the live site the member's real address belongs there; " +
      "on a copy it must be replaced, because Xero emails invoice reminders " +
      "from its own servers to whatever the contact holds. Guessing either way " +
      "is wrong — one emails real members from a copy, the other rewrites the " +
      "club's real accounting — so nothing was attempted. Reading from Xero is " +
      "unaffected.",
    ...resolution.notes,
  ].join(" ");
}

/**
 * True when this Xero operation would change something on the provider side.
 *
 * FAIL-CLOSED: anything whose name does not begin with `get` counts as a
 * mutation. See the module docblock for why an allowlist of write verbs was
 * rejected.
 */
export function isXeroProviderMutation(operation: string): boolean {
  return !/^get[A-Z]/.test(operation.trim());
}

/**
 * Refuse a Xero provider mutation while the installation is undeclared.
 *
 * Returns without reading anything when the operation is a read, so the role
 * resolver's primary-key read is spent only where it changes an outcome.
 */
export async function assertXeroProviderWriteAllowed(
  operation: string,
): Promise<void> {
  if (!isXeroProviderMutation(operation)) return;
  const resolution = await resolveEnvironmentRole();
  if (resolution.role !== "UNKNOWN") return;
  throw new XeroContactEnvironmentUnknownError(
    describeXeroContactEmailRefusal(resolution),
  );
}
