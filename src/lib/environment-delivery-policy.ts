/**
 * THE one place that decides whether this installation may contact a real member
 * (ENV-SAFETY 2, #3035; epic #2986). INV-CONFIG-004.
 *
 * Every application-controlled send — a member email through `sendEmail`, a
 * replay through the email retry cron, and the three places we ask Xero to email
 * an invoice — asks this module first. It answers from exactly TWO declarations,
 * each read through its own canonical parser and neither inferred from anything:
 * the environment role (`resolveEnvironmentRole()`, #3034, INV-CONFIG-003) and
 * the transport kind (`resolveEmailTransportKind()`, `email-delivery.ts`).
 *
 * ## The six answers
 *
 * - **allow, grounds `production`** — the club's live site. Live behaviour is
 *   unchanged aside from passing through here. Carries a
 *   {@link LiveProviderClearance}, the only token that opens a path which can
 *   reach a real member's inbox.
 * - **allow, grounds `non-production-capture`** — a confirmed copy whose operator
 *   has explicitly declared a CAPTURE transport (`USE_LOCAL_CAPTURE`, mailpit in
 *   the browser suite). The message really is transmitted, into something that
 *   cannot deliver onward, so calling it "suppressed" would be false. Carries a
 *   plain {@link DeliveryClearance}, which opens a mail transport and NOT the Xero
 *   invoice-email wrapper — see below.
 * - **suppress_non_production** — a confirmed copy pointed at a live provider.
 *   Nothing is transmitted and no provider is contacted. A NORMAL, terminal
 *   outcome: a copy behaving correctly, not a fault.
 * - **block_environment_unknown** — nothing has declared which installation this
 *   is, or the safer override could not be read. Nothing transmitted, and this IS
 *   a fault: it is recorded as retryable, and for a message whose body is
 *   retained it clears itself the moment an operator declares the role.
 * - **block_capture_in_production** — the club's live site declares a capture
 *   transport. Refused, loudly, because a live installation quietly dropping
 *   every member's mail into a sink is the same class of harm as declaring the
 *   live site a copy. Also a fault, also retryable on the same terms.
 * - **block_capture_public_host** — a copy declares a capture transport while
 *   `EMAIL_SERVER_HOST` names a host on the public internet, so the "capture"
 *   would deliver to a real member (#3071 review, hoppers99). Refused. This is
 *   the shape an EXISTING relay installation lands in when it flips
 *   `USE_LOCAL_CAPTURE` on upgrade and changes nothing else, which is why the
 *   repair strings now name the host as well as the flag. A fault, retryable, and
 *   deliberately not folded into either neighbour — see
 *   {@link EmailTransportKind}.
 *
 * "RETRYABLE" IS CONDITIONAL, and saying so is not a caveat — it was a false
 * claim in seven places before #3035's review. Twenty-six templates never persist
 * their rendered body (a sign-in link, a door code, a payment link must not sit
 * at rest), and the retry cron cannot replay a row with no body. Those rows are
 * pushed to the retry ceiling so they land in the operator's email-failure review
 * queue, and every sentence about them says "re-send it by hand" instead. See
 * {@link DeliveryReplayability}.
 *
 * WHY THE OUTCOMES MUST STAY APART, since collapsing any pair is the defect this
 * issue exists to prevent. A business withhold (the booking's "No emails" switch)
 * says *the club decided not to email this person*. A safety suppression says
 * *this is not the club's live site*. An unknown-environment block says *we do
 * not know, so we are not risking it*. A capture-in-production block says *your
 * configuration is wrong in a way that loses mail*. A provider failure says *we
 * tried and it broke*. Five different remedies, so an operator who cannot tell
 * them apart cannot act on any of them.
 *
 * WHY UNKNOWN GETS NO CAPTURE EXEMPTION, stated because the asymmetry with the
 * non-production case is deliberate and would otherwise read as an oversight. A
 * capture declaration is a claim by the same deployment configuration that has
 * failed to say what the installation is. An installation that cannot answer the
 * first question has not earned an exemption on the strength of its answer to the
 * second, and UNKNOWN failing closed is this issue's rule with no carve-outs.
 *
 * ## The clearance tokens, and why a type carries the guarantee
 *
 * A text census can only see the senders that exist today. The tokens make the
 * rule a COMPILE-TIME one instead: `getEmailTransporter` requires a
 * `DeliveryClearance`, `sendXeroInvoiceEmail` requires the narrower
 * `LiveProviderClearance`, both brands are unforgeable outside this module (the
 * brand is a non-exported `unique symbol`), and this module mints them only on
 * the branches above. So a new sender cannot obtain a transport without coming
 * through here — not because a test says so, but because there is no other way to
 * produce the argument.
 *
 * THE TWO TOKENS ARE NOT INTERCHANGEABLE, and that is what keeps the capture
 * exemption honest. A capture mailbox intercepts mail THIS APPLICATION sends. It
 * does nothing whatever about asking Xero to email an invoice: Xero sends that
 * from its own servers to the member's real address, so a capture container never
 * sees it. `LiveProviderClearance` is therefore minted only for confirmed
 * production, it is assignable to `DeliveryClearance` and not the other way
 * round, and a capture installation consequently cannot reach `emailInvoice` even
 * though it can send its own mail.
 *
 * IT IS RE-ASSERTED AT RUNTIME as well, in {@link requireDeliveryClearance}. A
 * cast (`{} as unknown as DeliveryClearance`) defeats the type and nothing else:
 * the runtime check refuses a token this module did not mint, and then re-resolves
 * the decision and refuses anything that is no longer an allow. That costs one
 * primary-key read of a one-row table per send, which is the price of the
 * guarantee rather than an oversight — see `environment-role.ts` on why that
 * resolver is deliberately uncached.
 */

import {
  resolveEmailTransportKind,
  type EmailTransportKind,
} from "@/lib/email-delivery";
import {
  resolveEnvironmentRole,
  type EnvironmentRoleDecidedBy,
  type EnvironmentRoleResolution,
  type EnvironmentSafetySettingsStore,
} from "@/lib/environment-role";

/**
 * The brand. Deliberately NOT exported: a caller cannot write the property, so a
 * caller cannot write a value of either type. A `unique symbol` rather than a
 * string literal key, so no structurally-identical object can be assembled by
 * accident.
 */
declare const clearanceBrand: unique symbol;

/** Proof that this installation may open a mail transport of its own. */
export type DeliveryClearance = {
  readonly [clearanceBrand]: "production-confirmed" | "capture-confirmed";
};

/**
 * Proof that this installation is the club's live site, and may therefore reach a
 * real member's inbox — including by asking a provider to send on our behalf.
 *
 * Narrower than {@link DeliveryClearance} on purpose: this one is assignable to
 * that one, and not the reverse, so a capture installation type-checks for its own
 * transport and fails to compile against the Xero invoice-email wrapper.
 */
export type LiveProviderClearance = {
  readonly [clearanceBrand]: "production-confirmed";
};

/**
 * The runtime witness behind the compile-time brands.
 *
 * A module-private symbol, so a forged object cannot carry it and a serialized
 * one cannot either — symbols do not survive JSON. This is what makes the cast
 * escape hatch fail closed instead of silently working.
 */
const CLEARANCE_WITNESS: unique symbol = Symbol("delivery-clearance");

type MintedClearance = { readonly [CLEARANCE_WITNESS]: DeliveryGrounds };

/** Which of the two allow branches produced a clearance. */
export type DeliveryGrounds = "production" | "non-production-capture";

function mintLiveProviderClearance(): LiveProviderClearance {
  // The double cast is the mint. `MintedClearance` and the branded types have no
  // property in common by design — the brand is phantom and the witness is real —
  // so TypeScript will not bridge them directly, and going through `unknown` here
  // is the one place in the codebase allowed to do it.
  const minted: MintedClearance = { [CLEARANCE_WITNESS]: "production" };
  return minted as unknown as LiveProviderClearance;
}

function mintCaptureClearance(): DeliveryClearance {
  const minted: MintedClearance = {
    [CLEARANCE_WITNESS]: "non-production-capture",
  };
  return minted as unknown as DeliveryClearance;
}

/**
 * Why an installation's role could not be confirmed, as the three states an
 * operator has to be able to tell apart.
 *
 * Derived from the resolution's own `declaration` and `databaseOverride` — never
 * re-read from anywhere — because the repair differs: `declaration_missing`
 * means set the variable, `declaration_invalid` means fix the typo in the value
 * already set, and `override_unreadable` means the database could not answer at
 * all, which is usually a migration that has not been applied here.
 */
export type DeliveryBlockReason =
  | "declaration_missing"
  | "declaration_invalid"
  | "override_unreadable";

/**
 * The decision, WITHOUT a clearance.
 *
 * WHY THE SPLIT EXISTS, because it is a security boundary and not tidiness. This
 * shape is what the pure {@link decideDeliveryPolicy} returns, and it is exported
 * so every combination stays assertable from a test without a database. If that
 * function minted the real token — which it did — then anybody holding an
 * `EnvironmentRoleResolution` could hand it `{ role: "PRODUCTION" }` and receive a
 * genuine `LiveProviderClearance` stamped with the real witness. No cast is
 * involved, so the cast census does not fire; and while the send path survives
 * because `getEmailTransporter` re-resolves, `sendXeroInvoiceEmail` checks the
 * witness ONLY. A review lens drove `accountingApi.emailInvoice` to a real call
 * that way on an installation whose real declaration was `non-production`.
 *
 * So the mint moved to {@link resolveDeliveryPolicy}, which reads the real
 * sources itself. The module's central claim — "there is no other way to produce
 * the argument" — is now true.
 */
export type DeliveryOutcome =
  | { kind: "allow"; grounds: "production" }
  | { kind: "allow"; grounds: "non-production-capture" }
  | { kind: "suppress_non_production"; decidedBy: EnvironmentRoleDecidedBy }
  | { kind: "block_environment_unknown"; reason: DeliveryBlockReason }
  | { kind: "block_capture_in_production" }
  | { kind: "block_capture_public_host" };

/** {@link DeliveryOutcome} with the clearance the allow branches carry. */
export type DeliveryDecision =
  | { kind: "allow"; grounds: "production"; clearance: LiveProviderClearance }
  | {
      kind: "allow";
      grounds: "non-production-capture";
      clearance: DeliveryClearance;
    }
  | { kind: "suppress_non_production"; decidedBy: EnvironmentRoleDecidedBy }
  | { kind: "block_environment_unknown"; reason: DeliveryBlockReason }
  | { kind: "block_capture_in_production" }
  | { kind: "block_capture_public_host" };

/**
 * The mapping from a resolved role plus a declared transport to a delivery
 * decision, as a pure function so every combination is assertable without a
 * database or an environment.
 *
 * IT MINTS NOTHING. See {@link DeliveryOutcome} for why that matters — it takes
 * caller-supplied input, so a clearance produced here would be a clearance
 * anybody could ask for.
 *
 * THE ORDER OF THE UNKNOWN BRANCHES MATTERS, and it mirrors the resolver's own
 * precedence: an unreadable override resolves UNKNOWN even under a declared
 * `production`, so it is checked FIRST. Reading the declaration first would
 * report "you have not set the variable" to an operator who has set it correctly
 * and whose database is the actual fault — sending them to fix the one thing that
 * is already right.
 */
export function decideDeliveryPolicy(
  resolution: EnvironmentRoleResolution,
  transport: EmailTransportKind,
): DeliveryOutcome {
  if (resolution.role === "PRODUCTION") {
    /*
      A live site declaring a capture transport is refused rather than allowed
      "because it is production". Left to run, it would accept every message,
      report every one as SENT, and deliver none of them — a silent total mail
      outage for the club, which is the same harm as the wrongly-declared copy this
      epic is built around, arriving from the opposite direction. Symmetric with
      #3034's deploy-gate refusal, and just as loud.
    */
    if (transport === "local-capture" || transport === "capture-public-host") {
      /*
        BOTH capture kinds, and the order matters: a live site that has declared
        capture mode is refused for BEING a live site in capture mode, whatever
        its host turned out to be. Reporting the host problem here would send the
        operator of the club's live site off to fix `EMAIL_SERVER_HOST` when the
        thing that is wrong is the capture declaration itself.
      */
      return { kind: "block_capture_in_production" };
    }
    return { kind: "allow", grounds: "production" };
  }
  if (resolution.role === "NON_PRODUCTION") {
    /*
      The one exemption, and the reason it is safe: a capture mailbox cannot
      deliver onward, so transmitting into it reaches nobody. It is also what the
      issue asks for in as many words — "explicit local/capture transports remain
      valid" — and it is what lets the browser suite read a two-factor code back
      out of mailpit while nothing can reach a member.

      IT RESTS ON THE DECLARATION BEING TRUE, AND ON ONE CHECK OF IT. An earlier
      version of this comment said the application "cannot detect" a capture
      declared against a relay that really delivers. That was too strong, and the
      gap it excused was real (#3071 review, hoppers99): it cannot detect a
      PRIVATE host that forwards onward, but it can certainly detect
      `EMAIL_SERVER_HOST=smtp.sendgrid.net`, which is what an existing relay
      installation is left holding when it flips one flag on upgrade. That case
      arrives here as `capture-public-host` and is refused below. What remains
      undetectable is a sink on a private address that forwards anyway, and that
      is answered the way the rest of this epic answers such things: the
      deployment says what it is, explicitly, and no sentence anywhere claims more
      than the check can support.
    */
    if (transport === "capture-public-host") {
      return { kind: "block_capture_public_host" };
    }
    if (transport === "local-capture") {
      return { kind: "allow", grounds: "non-production-capture" };
    }
    return { kind: "suppress_non_production", decidedBy: resolution.decidedBy };
  }
  if (resolution.databaseOverride.kind === "unreadable") {
    return { kind: "block_environment_unknown", reason: "override_unreadable" };
  }
  return {
    kind: "block_environment_unknown",
    reason:
      resolution.declaration.kind === "invalid"
        ? "declaration_invalid"
        : "declaration_missing",
  };
}

/**
 * {@link decideDeliveryPolicy} over the live role and the live transport, and the
 * ONLY place a clearance is minted.
 *
 * The mint sits here rather than in the pure function above because this is where
 * the inputs are read from their canonical sources instead of handed in by a
 * caller. A test can still assert every row of the decision table; it can no
 * longer manufacture the token that opens a live provider path.
 */
export async function resolveDeliveryPolicy(
  store?: EnvironmentSafetySettingsStore,
): Promise<DeliveryDecision> {
  const outcome = decideDeliveryPolicy(
    await resolveEnvironmentRole(store),
    resolveEmailTransportKind(),
  );
  if (outcome.kind !== "allow") return outcome;
  return outcome.grounds === "production"
    ? { kind: "allow", grounds: "production", clearance: mintLiveProviderClearance() }
    : {
        kind: "allow",
        grounds: "non-production-capture",
        clearance: mintCaptureClearance(),
      };
}

/**
 * Whether a blocked message can actually be replayed once the fault is repaired.
 *
 * THE CLAIM HAD TO BECOME CONDITIONAL BECAUSE IT WAS FALSE FOR TWENTY-SIX
 * TEMPLATES (#3035 review). A blocked row keeps whatever body it holds — but
 * `sendEmail` persists NO body for `SENSITIVE_EMAIL_LOG_TEMPLATES`
 * (`booking-confirmed`, `pre-arrival-reminder`, `split-guest-payment-link`,
 * `membership-application-approved`, `age-up-invitation`, every token template …)
 * nor for any message whose log recipient is redacted, because retaining it would
 * leave live sign-in links, door codes and payment links at rest. The email retry
 * cron requires a body, so those rows can never be replayed, and telling an
 * operator "it goes out by itself" sends them away from the one action that would
 * actually get the message delivered.
 *
 * Retaining the body for those templates is NOT the fix — that is the hazard they
 * are excluded for. So the claim is made conditional and true, and the row is
 * landed where an operator sees it: see `email/environment-gate.ts`, which pushes
 * `attempts` to the retry ceiling for exactly these rows so they surface in the
 * email-failure review queue instead of surfacing nowhere.
 */
export type DeliveryReplayability =
  | "replayed-automatically"
  | "needs-a-manual-resend";

const REPLAY_CLAUSE: Record<DeliveryReplayability, string> = {
  "replayed-automatically":
    " The message is queued and goes out by itself once that is done.",
  "needs-a-manual-resend":
    " This message then has to be re-sent BY HAND: its contents are deliberately not stored — it carries something like a sign-in link, a door code or a payment link — so nothing can replay it automatically. It is listed under Admin -> Email for review.",
};

/**
 * Operator-facing, secret-free reason a send did not happen, or happened into a
 * capture.
 *
 * Written for whoever reads an email log row or a Xero sync operation months
 * later, so it says what happened, what it is NOT, and what to do. It names
 * variables and screens, and never a credential, an address or a message body.
 *
 * `replay` defaults to `replayed-automatically`, which is right for every caller
 * that holds a retained body (the retry cron) or no EmailLog row at all (the Xero
 * invoice-email wrapper, where the operator's action is the panel's own Retry).
 * The mail gate passes the real answer for the row it is about to write.
 */
export function describeDeliveryDecision(
  decision: DeliveryOutcome,
  replay: DeliveryReplayability = "replayed-automatically",
): string {
  if (decision.kind === "allow") {
    /*
      THE CAPTURE SENTENCE USED TO END "and can reach nobody outside it", which
      was an unconditional claim resting on nothing but the flag (#3071 review,
      hoppers99). On the installation that found it, the flag was set and
      EMAIL_SERVER_HOST still named a live relay, so that sentence was written
      into the log of a message that had just reached a real member. The host is
      now checked — see `classifyCaptureHost` — but the sentence deliberately does
      NOT recite that check. It cannot prove onward forwarding, and an operator
      who used `EMAIL_CAPTURE_ALLOW_PUBLIC_HOST` has overridden it, so a line
      claiming the host had been vetted would be false on the very installation
      where the guarantee is weakest. What is left is true everywhere: the message
      went to the capture, and the capture's behaviour is a declaration rather
      than a measurement. The check protects; the log line only has to be honest.
    */
    return decision.grounds === "production"
      ? "This installation is the club's live site, so the message was delivered normally."
      : "This installation is a copy with a local capture mailbox declared (USE_LOCAL_CAPTURE), so the message was transmitted into that capture instead of to the member. Whether that capture can pass mail onward is what this deployment declares about EMAIL_SERVER_HOST, not something this application can verify.";
  }
  if (decision.kind === "suppress_non_production") {
    // Terminal, so no replay clause: a copy is a copy until somebody
    // re-declares it, and replaying weeks of stale mail at real members if they
    // ever did would be worse than not sending it.
    return decision.decidedBy === "database-safer-override"
      ? "Held back: an administrator has switched this installation's safer override on, so it behaves as a copy and does not contact real members. Nothing was sent and no provider was contacted. Turn the override off under Admin -> Environment if this really is the club's live site."
      : "Held back: this deployment declares itself a copy (APP_ENVIRONMENT_ROLE=non-production), so it does not contact real members. Nothing was sent and no provider was contacted. To let a copy send into a local capture mailbox instead, declare USE_LOCAL_CAPTURE=true and point EMAIL_SERVER_HOST at it.";
  }
  if (decision.kind === "block_capture_public_host") {
    return `Not sent: this installation is a copy that declares a local capture mailbox (USE_LOCAL_CAPTURE=true), but EMAIL_SERVER_HOST names a host on the public internet, so the "capture" would have delivered this message to a real member. Nothing was sent and no provider was contacted. Point EMAIL_SERVER_HOST at the capture itself — a container name such as mailpit, localhost, or a private address — or set USE_SMTP_RELAY=true instead if that host really does deliver mail, in which case this copy holds every message back rather than sending it. If the host genuinely is a sink that forwards nothing and only has a public name, declare EMAIL_CAPTURE_ALLOW_PUBLIC_HOST=true.${REPLAY_CLAUSE[replay]}`;
  }
  if (decision.kind === "block_capture_in_production") {
    return `Not sent: this deployment declares itself the club's live site (APP_ENVIRONMENT_ROLE=production) AND declares a local capture mailbox (USE_LOCAL_CAPTURE=true). Those cannot both be true — a live site in capture mode would accept every message and deliver none of them. Nothing was sent and no provider was contacted. Set USE_AWS_SES or USE_SMTP_RELAY instead.${REPLAY_CLAUSE[replay]}`;
  }
  if (decision.reason === "override_unreadable") {
    return `Not sent: this installation's environment-safety override could not be read from the database, so we cannot confirm whether this is the club's live site or a copy. Nothing was sent and no provider was contacted. Apply pending migrations (prisma migrate deploy) or restore database access.${REPLAY_CLAUSE[replay]}`;
  }
  if (decision.reason === "declaration_invalid") {
    return `Not sent: APP_ENVIRONMENT_ROLE is set to a value this application refuses to interpret, so we cannot tell whether this is the club's live site or a copy. Nothing was sent and no provider was contacted. Set it to exactly production or non-production — it is not APP_RUNTIME_ROLE.${REPLAY_CLAUSE[replay]}`;
  }
  return `Not sent: nothing in this deployment says whether it is the club's live site or a copy, so we will not risk emailing real members. Nothing was sent and no provider was contacted. Set APP_ENVIRONMENT_ROLE to production or non-production — it is not APP_RUNTIME_ROLE, which names the container slot.${REPLAY_CLAUSE[replay]}`;
}

/** Thrown when a delivery entry point is reached without a genuine clearance. */
export class DeliveryClearanceError extends Error {}

/**
 * The cheap half of the runtime re-assert: this token really was minted here.
 *
 * WHAT IT IS FOR. TypeScript's brand is erased at runtime, so
 * `{} as unknown as DeliveryClearance` type-checks. Without this check that cast
 * would open a live provider connection — the escape hatch would work. With it
 * the cast fails closed, because the witness is a module-private symbol nobody
 * else can spell and nothing can deserialize.
 *
 * `require` names the narrowest grounds the caller accepts: `"production"` for a
 * path that can reach a real inbox, or `"any"` for one a capture can satisfy. A
 * capture token presented to a production-only path is refused HERE as well as at
 * compile time, so a cast cannot buy what the type forbids.
 *
 * Synchronous and database-free ON PURPOSE, so it is safe to call from inside a
 * transaction holding an advisory lock. See `sendXeroInvoiceEmail` in
 * `xero-invoice-email.ts`, which is exactly that case.
 */
export function assertDeliveryClearanceWitness(
  clearance: DeliveryClearance,
  require: "production" | "any" = "any",
): DeliveryGrounds {
  const witnessed = (clearance as unknown as Partial<MintedClearance> | null)?.[
    CLEARANCE_WITNESS
  ];
  if (witnessed !== "production" && witnessed !== "non-production-capture") {
    throw new DeliveryClearanceError(
      "Refusing to open a delivery path: the caller did not present a delivery clearance minted by src/lib/environment-delivery-policy.ts. Call resolveDeliveryPolicy() and pass the clearance from its allow branch (INV-CONFIG-004).",
    );
  }
  if (require === "production" && witnessed !== "production") {
    throw new DeliveryClearanceError(
      "Refusing to ask a provider to email a member: this installation is a copy with a local capture mailbox, which intercepts only the mail this application sends itself. A provider asked to send on our behalf delivers from its own servers to the member's real address, so the capture never sees it (INV-CONFIG-004).",
    );
  }
  return witnessed;
}

/**
 * Re-prove, at the moment of delivery, that this installation may still send.
 *
 * BOTH CHECKS, because each catches something the other cannot: the witness above
 * catches a forged token, and re-resolving the decision catches a token that WAS
 * genuine and is no longer true. An administrator can switch the safer override on
 * while a batch is mid-flight, and that click is the one somebody makes when they
 * have just realised a copy is about to email the club's real members.
 *
 * THIS FUNCTION CAN ONLY PROTECT WHAT ASKS IT, and that sentence is here because
 * omitting it made the paragraph above false in one place (#3071 review,
 * hoppers99). A caller that resolves once and then sends fifty messages gets ONE
 * check, however carefully this function re-resolves. Both callers now ask per
 * message: `sendEmail` through `getEmailTransporter` for every message it renders,
 * and `cron-email-retry.ts` inside its own loop rather than once above it, which
 * is what it used to do. A future third sender that hoists the call out of its
 * loop reopens the same hole, and nothing here can stop it — the check is
 * per-call by construction, so the discipline belongs at the call site.
 *
 * The second half costs one primary-key read per call, and it is spent here rather
 * than in the Xero wrapper for a stated reason: this function guards a CACHED
 * transport that a long batch can keep reusing, while the Xero path calls its
 * provider once, immediately after a fresh resolution, from inside a transaction
 * where a second connection would be a real hazard.
 *
 * Returns the grounds so its caller can state the RULE it applies rather than the
 * conclusion — see `implicitSesDefaultFor` in `src/lib/email/internal.ts`.
 */
export async function requireDeliveryClearance(
  clearance: DeliveryClearance,
): Promise<DeliveryGrounds> {
  const presented = assertDeliveryClearanceWitness(clearance);
  const decision = decideDeliveryPolicy(
    await resolveEnvironmentRole(),
    resolveEmailTransportKind(),
  );
  if (decision.kind !== "allow") {
    throw new DeliveryClearanceError(
      `Refusing to open a delivery path: this installation may no longer send. ${describeDeliveryDecision(decision)}`,
    );
  }
  /*
    The grounds have to MATCH, not merely both be allows. A production token
    presented on an installation that has since become a capture copy would
    otherwise carry production's licence — including the legacy implicit AWS SES
    default — onto a copy. The token says what was true when it was minted; the
    re-resolution says what is true now, and only the pair agreeing is a licence.
  */
  if (decision.grounds !== presented) {
    throw new DeliveryClearanceError(
      `Refusing to open a delivery path: this clearance was minted for a ${presented} installation and this one now resolves ${decision.grounds}. ${describeDeliveryDecision(decision)}`,
    );
  }
  return decision.grounds;
}
