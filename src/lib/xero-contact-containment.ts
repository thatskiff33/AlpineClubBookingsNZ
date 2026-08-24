/**
 * THE one place that decides what email address may reach a Xero contact, and
 * the one place that proves an existing contact has been contained (ENV-SAFETY
 * 3, #3036; epic #2986). INV-CONFIG-005.
 *
 * ## What this is for, in one paragraph
 *
 * #3035 stopped a copy of the club's site sending mail, including the three
 * places we ask Xero to email an invoice. It did not — and could not — stop XERO
 * emailing. An invoice is raised `AUTHORISED`, this issue requires it stay that
 * way so settlement behaviour remains testable on a copy, and Xero's own invoice
 * reminders go out from Xero's servers to the address stored on the contact with
 * no API call from this application at all. So on a copy the address stored on
 * the contact has to stop being a member's, and it has to stop being one BEFORE
 * an invoice exists to remind anybody about.
 *
 * ## It reads the ROLE, never the delivery policy
 *
 * `resolveDeliveryPolicy()` is right there and it is the wrong tool, so the
 * reason is written down rather than left to be rediscovered. That policy
 * carries a capture-transport carve-out: a confirmed copy whose operator has
 * declared a local capture mailbox is ALLOWED to transmit, because a capture
 * catches everything this application sends. A capture catches nothing Xero
 * sends. So a copy needs full Xero containment REGARDLESS of its transport mode,
 * and this module consumes `resolveEnvironmentRole()` (#3034, INV-CONFIG-003)
 * directly. #3035 made that structural too: `sendXeroInvoiceEmail` requires the
 * narrower `LiveProviderClearance`, so a capture clearance cannot reach it.
 *
 * ## The three answers
 *
 * - **PRODUCTION — nothing is transformed and nothing is recorded.** No
 *   transform, no provider read, no row written. `applyXeroContactEmailPolicy`
 *   is the identity function on this branch, so every payload, every stored
 *   request payload and every idempotency key on the club's live site is
 *   byte-identical to what it was before this issue. That is the half a reviewer
 *   should check hardest and it is deliberately trivial to check.
 *
 *   IT IS NOT "no behaviour change of any kind", and the earlier wording that
 *   said so was overclaiming. Asking the question costs a read:
 *   `resolveEnvironmentRole()` is deliberately uncached (see its docblock — a
 *   cache would delay the safer override an administrator presses in an
 *   emergency), so each contact resolution adds one primary-key read of a
 *   one-row table on the live site too. A three-hundred-charge subscription run
 *   adds three hundred of them. That is the price of the guarantee, and it is
 *   written down rather than glossed.
 * - **NON_PRODUCTION — contain.** Addresses written into a contact payload are
 *   replaced by their contained form, and a contact that already exists is
 *   proved contained before its id is returned to whatever is about to invoice
 *   it.
 * - **UNKNOWN — refuse.** No transform (UNKNOWN is not evidence of being a
 *   copy, so writing a contained address over the club's real accounting on a
 *   guess is exactly as wrong as emailing real members on a guess), and no
 *   role-dependent provider side effect either. {@link
 *   resolveXeroContactEmailPolicy} throws {@link XeroContactEnvironmentUnknownError}
 *   carrying the resolver's own operator-facing notes, which name the variable
 *   to set and the screen to set it on.
 *
 * ## The clearance token, and why a type carries the guarantee
 *
 * Same shape as #3035's `DeliveryClearance`, for the same reason: a text census
 * can only see the writers that exist today. {@link applyXeroContactEmailPolicy}
 * requires a {@link XeroContactEmailPolicy}, the brand is a non-exported `unique
 * symbol` so nothing outside this module can produce a value of that type, and
 * the runtime witness is a module-private `Symbol` so the cast that defeats the
 * type (`{} as unknown as XeroContactEmailPolicy`) fails closed instead of
 * silently working. The pure decision function {@link decideXeroContactEmailPolicy}
 * MINTS NOTHING — it takes caller-supplied input, and #3035's review found that
 * a pure function which mints is a function anybody can ask for a token.
 *
 * ## The PROOF lives next door
 *
 * This module decides what may reach a Xero contact. Whether a contact that
 * already exists has been PROVED unable to reach a member — the durable record,
 * its freshness bound, the provider read-back, and the refusal when none of that
 * can be established — is `xero-contact-containment-proof.ts`. The split is
 * along the line between a decision (pure, synchronous, database-free once the
 * role is read) and an act with provider and database consequences, and it is
 * what keeps either half readable in one sitting.
 *
 * ## Placeholder semantics stay separate
 *
 * The contained domain is never added to `PLACEHOLDER_CONTACT_EMAIL_DOMAINS`.
 * See `xero-sandbox-contact-email.ts` for the full argument; the short version is
 * that a contained member is not an unreachable member, and reporting them as
 * one would change booking flows and reminder crons on a copy, which is the
 * production-likeness this issue exists to keep.
 */

import {
  resolveEnvironmentRole,
  type EnvironmentRole,
} from "@/lib/environment-role";
import {
  describeXeroContactEmailRefusal,
  XeroContactEnvironmentUnknownError,
} from "@/lib/xero-environment-write-gate";
import { toXeroSandboxContactEmail } from "@/lib/xero-sandbox-contact-email";

/**
 * The brand. Deliberately NOT exported: a caller cannot write the property, so a
 * caller cannot write a value of this type. A `unique symbol` rather than a
 * string key, so no structurally-identical object can be assembled by accident.
 */
declare const xeroContactEmailPolicyBrand: unique symbol;

/** What the policy decided to do with a contact's email address. */
export type XeroContactEmailMode = "verbatim" | "contain";

/**
 * Proof that the environment role has been read, and permission to put an
 * address into a Xero contact payload.
 *
 * One brand for both live answers rather than two, because unlike #3035's two
 * clearances there is no path here that one answer may take and the other may
 * not: both may write a contact, and the whole difference is WHICH address gets
 * written. The mode travels inside the token and the runtime witness carries it,
 * so `applyXeroContactEmailPolicy` cannot be fooled about which one it holds.
 */
export type XeroContactEmailPolicy = {
  readonly [xeroContactEmailPolicyBrand]: XeroContactEmailMode;
};

/**
 * The runtime witness behind the compile-time brand: a module-private symbol, so
 * a forged object cannot carry it and a deserialized one cannot either — symbols
 * do not survive JSON. This is what makes the cast escape hatch fail closed.
 */
const XERO_CONTACT_POLICY_WITNESS: unique symbol = Symbol(
  "xero-contact-email-policy",
);

type MintedXeroContactEmailPolicy = {
  readonly [XERO_CONTACT_POLICY_WITNESS]: XeroContactEmailMode;
};

function mintXeroContactEmailPolicy(
  mode: XeroContactEmailMode,
): XeroContactEmailPolicy {
  // The double cast is the mint. `MintedXeroContactEmailPolicy` and the branded
  // type have no property in common by design — the brand is phantom and the
  // witness is real — so going through `unknown` here is the one place in this
  // codebase allowed to bridge them.
  const minted: MintedXeroContactEmailPolicy = {
    [XERO_CONTACT_POLICY_WITNESS]: mode,
  };
  return minted as unknown as XeroContactEmailPolicy;
}

/** Thrown when a contact-payload entry point is reached without a real policy. */
export class XeroContactEmailPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XeroContactEmailPolicyError";
  }
}


/** {@link XeroContactEmailDecision} without the token. */
export type XeroContactEmailOutcome =
  | { kind: "verbatim" }
  | { kind: "contain" }
  | { kind: "block_environment_unknown" };

/** {@link XeroContactEmailOutcome} with the token the two live branches carry. */
export type XeroContactEmailDecision =
  | { kind: "verbatim"; policy: XeroContactEmailPolicy }
  | { kind: "contain"; policy: XeroContactEmailPolicy };

/**
 * The mapping from a resolved role to what may reach a Xero contact, as a pure
 * function so all three answers are assertable without a database.
 *
 * IT MINTS NOTHING — see the module docblock.
 */
export function decideXeroContactEmailPolicy(
  role: EnvironmentRole,
): XeroContactEmailOutcome {
  if (role === "PRODUCTION") return { kind: "verbatim" };
  if (role === "NON_PRODUCTION") return { kind: "contain" };
  return { kind: "block_environment_unknown" };
}

/**
 * {@link decideXeroContactEmailPolicy} over the live role, and the ONLY place a
 * policy token is minted.
 *
 * The mint sits here rather than in the pure function above because this is
 * where the role is read from its canonical resolver instead of handed in by a
 * caller. Throws on UNKNOWN rather than returning a third variant: every caller
 * of this function is a provider write and every one of them must refuse, so a
 * variant to ignore would be a variant somebody ignores.
 */
export async function resolveXeroContactEmailPolicy(): Promise<XeroContactEmailDecision> {
  const resolution = await resolveEnvironmentRole();
  const outcome = decideXeroContactEmailPolicy(resolution.role);
  if (outcome.kind === "block_environment_unknown") {
    throw new XeroContactEnvironmentUnknownError(
      describeXeroContactEmailRefusal(resolution),
    );
  }
  return { kind: outcome.kind, policy: mintXeroContactEmailPolicy(outcome.kind) };
}

/**
 * The runtime half of the guarantee: this token really was minted here.
 *
 * TypeScript's brand is erased at runtime, so `{} as unknown as
 * XeroContactEmailPolicy` type-checks. Without this check that cast would put a
 * member's real address on a copy's Xero contact — the type would be satisfied
 * and the identity branch taken. With it, the cast throws.
 *
 * Synchronous and database-free ON PURPOSE, so it is safe to call from anywhere,
 * including a payload builder running inside a short transaction. The role was
 * read microseconds earlier by {@link resolveXeroContactEmailPolicy}; this is
 * the anti-forgery check, not a second role read.
 */
export function assertXeroContactEmailPolicyWitness(
  policy: XeroContactEmailPolicy,
): XeroContactEmailMode {
  const witnessed = (
    policy as unknown as Partial<MintedXeroContactEmailPolicy> | null
  )?.[XERO_CONTACT_POLICY_WITNESS];
  if (witnessed !== "verbatim" && witnessed !== "contain") {
    throw new XeroContactEmailPolicyError(
      "Refusing to put an email address on a Xero contact: the caller did not " +
        "present a policy minted by src/lib/xero-contact-containment.ts. Call " +
        "resolveXeroContactEmailPolicy() and pass the policy it returns " +
        "(INV-CONFIG-005).",
    );
  }
  return witnessed;
}

/**
 * The address that may go into a Xero contact payload.
 *
 * On PRODUCTION this is `email` unchanged — the identity function, which is what
 * makes the live site byte-identical. On a confirmed copy it is the contained
 * form. There is no third behaviour and no way to reach this function without a
 * genuine policy.
 */
export function applyXeroContactEmailPolicy(
  policy: XeroContactEmailPolicy,
  email: string,
): string {
  return assertXeroContactEmailPolicyWitness(policy) === "verbatim"
    ? email
    : toXeroSandboxContactEmail(email);
}
