/**
 * THE ONLY PLACE THAT ASKS XERO TO EMAIL AN INVOICE (ENV-SAFETY 2, #3035; epic
 * #2986). INV-CONFIG-004.
 *
 * Three workflows raise an invoice and then ask Xero to send it to the member —
 * booking Internet Banking payments, group-settlement invoices and membership
 * subscription invoices. Every one of them is a provider send to a real member's
 * real address, and none of them goes anywhere near `sendEmail`, so the delivery
 * boundary has to cover them explicitly.
 *
 * The provider call lives here and nowhere else. That is enforced twice:
 * {@link sendXeroInvoiceEmail} requires a `LiveProviderClearance`, which only
 * `environment-delivery-policy.ts` can mint and only for CONFIRMED PRODUCTION —
 * not even a copy with a declared local capture mailbox can produce one — and
 * `email-delivery-boundary-census.test.ts` asserts at source level that the text
 * `accountingApi.emailInvoice(` appears in this file alone.
 *
 * ## What the callers must do with a non-allow answer, and what they must NOT
 *
 * WHAT IS NOT SENT IS THE ONLY THING THAT CHANGES. The invoice is already raised
 * in Xero and stays `AUTHORISED`; no booking, payment, charge or invoice business
 * state may be moved as though the provider had failed. In particular:
 *
 * - **A safety suppression is not an error.** It must not populate the
 *   `invoiceEmailError` that makes a sync operation `PARTIAL`, and it must not
 *   write a subscription charge to `EMAIL_FAILED`. Nothing failed: the invoice
 *   exists and we deliberately did not email it.
 * - **A safety suppression is not the club's "No emails" decision either.** It
 *   must not write a withheld-booking-email audit row, because that row means an
 *   administrator turned the switch on for that booking and it renders on the
 *   booking page as exactly that claim.
 * - **A copy with a declared capture mailbox is still a suppression here**, and
 *   that is the one place this boundary is stricter than `sendEmail`. A capture
 *   catches the mail this application sends itself; Xero emails an invoice from
 *   its own servers to the member's stored address, which no capture container
 *   ever sees.
 * - **A CONFIGURATION FAULT IS a fault** — nothing has declared the role, or a
 *   live site has declared a capture mailbox — and reuses the shape the existing
 *   unreadable-switch case already established: no audit row, a populated
 *   `invoiceEmailError` so the sync operation completes `PARTIAL` and stays
 *   visible to an operator, and no business-state change. It clears itself when
 *   the configuration is fixed only in the sense that the operation is visible and
 *   can be re-driven, or the invoice sent from Xero by hand — see the note on
 *   re-drives in each caller.
 */

import { RequestEmpty } from "xero-node";

import { callXeroApi } from "@/lib/xero-api-client";
import {
  assertDeliveryClearanceWitness,
  describeDeliveryDecision,
  resolveDeliveryPolicy,
  type LiveProviderClearance,
} from "@/lib/environment-delivery-policy";

/**
 * The narrowest shape of the Xero client this module needs.
 *
 * Structural rather than the `XeroClient` type, so a caller cannot be forced to
 * widen what it holds and a test does not have to build a whole client to
 * exercise the boundary.
 */
export type XeroInvoiceEmailClient = {
  accountingApi: {
    emailInvoice: (
      tenantId: string,
      invoiceId: string,
      requestEmpty: RequestEmpty,
      idempotencyKey?: string,
    ) => Promise<{ body?: unknown }>;
  };
};

/**
 * What a caller must do, decided ONCE here so all three invoice workflows behave
 * identically.
 *
 * `error` is the whole rule in one field. A confirmed copy gets `null`: nothing
 * failed, so nothing may populate the `invoiceEmailError` that turns a sync
 * operation `PARTIAL`, and a staging run that reported PARTIAL on every invoice
 * would train an operator to ignore PARTIAL. A configuration fault gets a real
 * `Error`, because an invoice went out unemailed and somebody has to see that.
 *
 * `logMessage` is deliberately context-free — the caller's log object already
 * carries the booking, settlement or charge id — so the wording cannot drift
 * between the three sites.
 */
export type XeroInvoiceEmailPolicy =
  | { kind: "allow"; clearance: LiveProviderClearance }
  | {
      kind: "withhold";
      suppressedForNonProduction: boolean;
      error: Error | null;
      logMessage: string;
    };

/**
 * Ask the environment-safety policy whether this installation may have Xero email
 * a member, and translate a no into what the caller has to record.
 *
 * Exposed separately from the send so a caller can ask BEFORE it enters a
 * transaction or takes an advisory lock. The group-settlement workflow needs
 * exactly that: its `emailInvoice` call is the one deliberately
 * provider-spanning fence inside `pg_advisory_xact_lock(1)`, and resolving the
 * role in there would open a second database connection while that lock is held.
 *
 * A DECLARED LOCAL CAPTURE MAILBOX IS NOT AN ALLOW HERE, and that asymmetry with
 * `sendEmail` is the point rather than an inconsistency. A capture intercepts the
 * mail THIS APPLICATION sends. Xero emails an invoice from its own servers to the
 * member's stored address, so a capture container never sees it and a copy that
 * called `emailInvoice` would reach a real member. The type says so too: this
 * function returns a `LiveProviderClearance`, which only confirmed production
 * mints.
 *
 * ONE WITHHOLD REASON PER EVENT, WHICHEVER CALLER ASKS. This answer says what the
 * ENVIRONMENT would do; it does not know whether something else has already
 * withheld the message, and a caller must not report both. The booking path
 * expresses that by not asking at all once the booking's own "No emails" switch
 * has withheld. The group-settlement path cannot: it has to resolve this OUTSIDE
 * its advisory-locked transaction (a second Prisma connection taken while holding
 * `pg_advisory_xact_lock(1)` is a pool hazard, with every other invoice run queued
 * behind it holding one of its own), so it records what its email GATE returned
 * rather than what this function said. It used to record this answer
 * unconditionally, and on a copy whose organiser had "No emails" on, the sync
 * payload asserted `invoiceEmailWithheldByNoEmails: true` AND
 * `invoiceEmailWithheldForEnvironment: true` — two reasons claiming one event,
 * which is precisely the conflation INV-CONFIG-004 exists to forbid (#3035
 * review).
 */
export async function resolveXeroInvoiceEmailPolicy(): Promise<XeroInvoiceEmailPolicy> {
  const decision = await resolveDeliveryPolicy();
  if (decision.kind === "allow" && decision.grounds === "production") {
    return { kind: "allow", clearance: decision.clearance };
  }
  const suppressedForNonProduction =
    decision.kind === "suppress_non_production" ||
    (decision.kind === "allow" && decision.grounds === "non-production-capture");
  const detail =
    decision.kind === "allow"
      ? "Held back: this installation is a copy. A local capture mailbox catches the mail this application sends itself, but an invoice email is sent by Xero from its own servers to the member's real address, so it is not caught and is not sent at all. The invoice exists in Xero and was not emailed."
      : describeDeliveryDecision(decision);
  return {
    kind: "withhold",
    suppressedForNonProduction,
    error: suppressedForNonProduction ? null : new Error(detail),
    logMessage: suppressedForNonProduction
      ? `Did not ask Xero to email this invoice. The invoice is raised in Xero and untouched. ${detail}`
      : `Did not ask Xero to email this invoice, and the sync operation is marked PARTIAL so the unemailed invoice stays visible. ${detail}`,
  };
}

/**
 * The provider call, gated on a clearance.
 *
 * Metered and retried through `callXeroApi` exactly as the three call sites did
 * before, and the idempotency key still comes from the caller — a per-invoice key
 * is what makes a re-drive a no-op rather than a second email.
 *
 * THE RUNTIME CHECK HERE IS THE WITNESS ONLY, not a second role read, and the
 * reason is stated rather than left as an inconsistency with
 * `getEmailTransporter`. A clearance reaches this function microseconds after
 * {@link resolveXeroInvoiceEmailPolicy} read the database for it, and the
 * group-settlement caller is inside `pg_advisory_xact_lock(1)` when it calls —
 * where a second Prisma connection is a genuine hazard, because that lock is
 * exclusive, so every other invoice run is queued behind it holding a connection
 * of its own. The witness check needs no connection and is what closes the cast
 * escape hatch, which is the part a type cannot defend.
 */
export async function sendXeroInvoiceEmail(params: {
  clearance: LiveProviderClearance;
  xero: XeroInvoiceEmailClient;
  tenantId: string;
  invoiceId: string;
  idempotencyKey: string;
  workflow: string;
  context: string;
}): Promise<{ body: unknown }> {
  assertDeliveryClearanceWitness(params.clearance, "production");
  const response = await callXeroApi(
    () =>
      params.xero.accountingApi.emailInvoice(
        params.tenantId,
        params.invoiceId,
        new RequestEmpty(),
        params.idempotencyKey,
      ),
    {
      operation: "emailInvoice",
      resourceType: "INVOICE",
      workflow: params.workflow,
      context: params.context,
    },
  );
  return { body: response.body ?? null };
}
