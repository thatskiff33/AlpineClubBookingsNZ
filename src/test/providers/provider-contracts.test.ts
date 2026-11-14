import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import synthetic from "./fixtures/provider-contracts.json";
import { StripeFake } from "./stripe-fake";
import { XeroFake } from "./xero-fake";
import { invoiceWire, invoiceWireDueCents } from "./round-trip-harness";
import { scanForSecrets } from "@/lib/diagnostics/knowledge/secret-scan";
import { EMAIL_ADDRESS_VALUE_PATTERNS } from "@/lib/email-address-patterns";

/**
 * Where the pinned expectations came from (#4908). `synthetic` fixtures are
 * hand-written from public docs and carry no capture data; `recorded-sandbox`
 * ones are sanitised sandbox replies and must say when they were captured,
 * against which API versions, and where the owner's review is recorded
 * (`docs/TESTING.md`, "Capturing sandbox fixtures").
 */
type Provenance = {
  kind: "synthetic" | "recorded-sandbox";
  capturedOn: string | null;
  apiVersions: { xero: string | null; stripe: string | null };
  reviewedIn: string | null;
};

/** The problems with a fixture file's provenance and content; empty when it is usable. */
function provenanceProblems(file: { provenance: Provenance }): string[] {
  const { kind, capturedOn, apiVersions, reviewedIn } = file.provenance;
  const problems: string[] = [];
  const captureFields = [capturedOn, apiVersions.xero, apiVersions.stripe, reviewedIn];
  if (kind === "synthetic") {
    if (captureFields.some((value) => value !== null)) problems.push("a synthetic fixture carries no capture date, API version or review");
  } else if (kind === "recorded-sandbox") {
    // Format only: the frozen test clock would date any real capture in the future.
    if (!capturedOn || !/^\d{4}-\d{2}-\d{2}$/.test(capturedOn)) problems.push("capturedOn must be a YYYY-MM-DD date");
    if (!apiVersions.xero || !apiVersions.stripe) problems.push("a recording names both providers' API versions");
    if (!reviewedIn || !/^#\d+$/.test(reviewedIn)) problems.push("reviewedIn names the issue or PR (#n) holding the owner's review");
  } else {
    problems.push(`unknown fixture kind ${String(kind)}`);
  }
  // Public repository: a recording keeps no address, secret or provider-minted id.
  const text = JSON.stringify(file);
  // The redactor's own email rule, so a URL-encoded address (`%40`) is caught too.
  if (EMAIL_ADDRESS_VALUE_PATTERNS.some((pattern) => pattern.test(text))) problems.push("an email address");
  // The bundle generator's scanner, plus prefixes it confirms by entropy but a fixture must never hold at all.
  if (scanForSecrets(text).length || /\b(?:sk|rk|pk)_(?:live|test)_|\bwhsec_|\bBearer\s|\beyJ[\w-]{8,}\.[\w-]{8,}\./i.test(text)) problems.push("a credential");
  if (/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i.test(text)) problems.push("a Xero GUID; replace it with a local alias");
  if (/\b(?:pi|ch|py|re|txn|po|in|ii|sub|si|seti|cs|cus|acct|evt|pm|src|card|tok)_[A-Za-z0-9]{14,}\b/.test(text)) problems.push("a Stripe object id; replace it with a local alias");
  return problems;
}

/**
 * A reviewed sandbox recording, when one is committed beside the synthetic set,
 * replaces it with the same keys; otherwise the synthetic set runs. The suite's
 * title names the kind it ran.
 */
const RECORDED = join(import.meta.dirname, "fixtures", "provider-contracts.recorded-sandbox.json");
type Fixtures = typeof synthetic & { provenance: Provenance };
const fixtures: Fixtures = existsSync(RECORDED) ? JSON.parse(readFileSync(RECORDED, "utf8")) : synthetic;
const provenance = fixtures.provenance;

it("provider fixture provenance is complete for its kind and carries nothing private", () => {
  expect(synthetic.provenance.kind).toBe("synthetic");
  expect(provenanceProblems(synthetic as Fixtures)).toEqual([]);
  expect(provenanceProblems(fixtures)).toEqual([]);
  if (fixtures !== synthetic) expect(provenance.kind).toBe("recorded-sandbox");
  const recorded: Provenance = { kind: "recorded-sandbox", capturedOn: "2026-06-30", apiVersions: { xero: "2.0", stripe: "2026-05-28.basil" }, reviewedIn: "#4908" };
  expect(provenanceProblems({ provenance: recorded })).toEqual([]);
  expect(provenanceProblems({ provenance: { ...recorded, capturedOn: "2026-11-12" } })).toEqual([]);
  expect(provenanceProblems({ provenance: { ...recorded, capturedOn: "12/11/2026" } })).toEqual(["capturedOn must be a YYYY-MM-DD date"]);
  expect(provenanceProblems({ provenance: { ...recorded, apiVersions: { xero: "2.0", stripe: null }, reviewedIn: null } })).toHaveLength(2);
  expect(provenanceProblems({ provenance: { ...synthetic.provenance as Provenance, capturedOn: "2026-06-30" } })).toEqual(["a synthetic fixture carries no capture date, API version or review"]);
  expect(provenanceProblems({ provenance: synthetic.provenance as Provenance, contact: "someone@example.com", key: "sk_test_abc", tenant: "0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0", intent: "pi_3Q0abcdEFGH12345" } as { provenance: Provenance })).toEqual([
    "an email address", "a credential", "a Xero GUID; replace it with a local alias", "a Stripe object id; replace it with a local alias",
  ]);
  // A Xero access token (a JWT), a scanner-only shape, and the Stripe ids a capture also mints.
  const withField = (value: string) => provenanceProblems({ provenance: synthetic.provenance as Provenance, value } as { provenance: Provenance });
  expect(withField("eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4eXoifQ.c2lnbmF0dXJl")).toEqual(["a credential"]);
  expect(withField(`ghp_${"aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5"}`)).toEqual(["a credential"]);
  expect(withField("https://api.xero.com/x?where=EmailAddress%3D%22jane%40example.com%22")).toEqual(["an email address"]);
  for (const id of ["txn_1Q0abcdEFGH12345", "py_1Q0abcdEFGH12345", "seti_1Q0abcdEFGH12345"]) expect(withField(id)).toEqual(["a Stripe object id; replace it with a local alias"]);
});

/** Fixed expectations are authored separately in JSON; never regenerate from the fake. */
describe(`provider fixture contracts (kind: ${provenance.kind}${provenance.capturedOn ? `, captured ${provenance.capturedOn}` : "; sandbox conformance unverified"})`, () => {
  it("pins Xero partial payment, allocation refusal, allocation removal, void and payment deletion", () => {
    const xero = new XeroFake();
    const c = xero.createContact("contact", "member-a");
    const i = xero.createInvoice("invoice", c.contactID, 8000);
    const payment = xero.payInvoice("payment", i.invoiceID, 5000);
    expect(invoiceWire(xero).Invoices[0]).toEqual(fixtures.xero.partPaid);
    expect(invoiceWireDueCents(xero)).toEqual([3000]);
    const n = xero.createCreditNote("credit", c.contactID, 3000);
    const a = xero.allocate("allocation", n.creditNoteID, i.invoiceID, 3000);
    expect(invoiceWire(xero).Invoices[0]).toEqual(fixtures.xero.allocated);
    const other = xero.createCreditNote("other-credit", c.contactID, 1000);
    expect(() => xero.allocate("paid-allocation", other.creditNoteID, i.invoiceID, 1000)).toThrow(expect.objectContaining({ response: fixtures.xero.paidAllocationError }));
    xero.removeAllocation(a.allocationID);
    xero.voidCreditNote(n.creditNoteID);
    expect(xero.snapshot().creditNotes[0]).toEqual(fixtures.xero.voidedCredit);
    xero.deletePayment(payment.paymentID);
    expect(xero.snapshot().payments[0]).toEqual(fixtures.xero.deletedPayment);
    expect(invoiceWireDueCents(xero)).toEqual([8000]);
  });

  it("pins Stripe partial capture, pending/success/failed-later refund and dashboard refund", () => {
    const stripe = new StripeFake();
    const i = stripe.createIntent("intent", "member-a", 8000);
    expect(i).toMatchObject(fixtures.stripe.authorised);
    expect(stripe.capture("capture", i.id, 5000)).toMatchObject(fixtures.stripe.captured);
    const r = stripe.refund("refund", i.id, 2000, "pending");
    expect(r).toMatchObject(fixtures.stripe.pending);
    stripe.succeedRefund(r.id);
    expect(stripe.snapshot().refunds[0]).toMatchObject(fixtures.stripe.succeeded);
    stripe.failRefund(r.id);
    expect(stripe.snapshot().refunds[0]).toMatchObject(fixtures.stripe.failedLater);
    expect(stripe.dashboardRefund(i.id, 5000)).toMatchObject(fixtures.stripe.dashboard);
    expect(() => stripe.refund("over-refund", i.id, 1)).toThrow(expect.objectContaining(fixtures.stripe.overRefundError));
    expect(stripe.snapshot().events.map(e => e.type)).toEqual(fixtures.stripe.eventTypes);
    expect(stripe.snapshot().events.at(-1)?.data.object).toMatchObject(fixtures.stripe.refundedCharge);
    // Webhook payloads are point-in-time copies, not references to mutable state.
    expect(stripe.snapshot().events[1].data.object).toMatchObject(fixtures.stripe.pending);
  });
});
