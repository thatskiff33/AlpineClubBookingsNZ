import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Xero invoice-email boundary, and the one place it is STRICTER than the
 * mailer (ENV-SAFETY 2, #3035; epic #2986; INV-CONFIG-004).
 *
 * A declared local capture mailbox lets a copy send its OWN mail, because the
 * capture forwards nothing. It does nothing at all about asking Xero to email an
 * invoice: Xero sends that from its own servers to the address stored on the
 * member's contact, so no capture container ever sees it and a copy that called
 * `emailInvoice` would reach a real member. This suite pins that asymmetry, which
 * is the kind of thing a later reader "tidies up" into consistency.
 */

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  emailInvoice: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { environmentSafetySettings: { findUnique: mocks.findUnique } },
}));
vi.mock("@/lib/logger", () => ({ default: mocks.logger }));
vi.mock("@/lib/xero-api-client", () => ({
  callXeroApi: async (fn: () => Promise<unknown>) => fn(),
}));

import { resolveDeliveryPolicy } from "@/lib/environment-delivery-policy";
import {
  resolveXeroInvoiceEmailPolicy,
  sendXeroInvoiceEmail,
} from "@/lib/xero-invoice-email";
import {
  declareEnvironmentRole,
  undeclareEnvironmentRole,
} from "@/lib/__tests__/helpers/environment-role";

function declareCaptureTransport() {
  vi.stubEnv("USE_AWS_SES", "");
  vi.stubEnv("USE_SMTP_RELAY", "");
  vi.stubEnv("USE_LOCAL_CAPTURE", "true");
  vi.stubEnv("EMAIL_SERVER_HOST", "mailpit");
  vi.stubEnv("EMAIL_SERVER_PORT", "1025");
  vi.stubEnv("EMAIL_SERVER_USER", "e2e");
  vi.stubEnv("EMAIL_SERVER_PASSWORD", "e2e");
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  mocks.findUnique.mockResolvedValue(null);
  mocks.emailInvoice.mockResolvedValue({ body: { sent: true } });
});

describe("resolveXeroInvoiceEmailPolicy", () => {
  it("allows only the club's live site", async () => {
    declareEnvironmentRole("production");
    const policy = await resolveXeroInvoiceEmailPolicy();
    expect(policy.kind).toBe("allow");
  });

  it("withholds on a copy WITH a declared capture mailbox, as a suppression rather than a fault", async () => {
    declareEnvironmentRole("non-production");
    declareCaptureTransport();

    const policy = await resolveXeroInvoiceEmailPolicy();

    expect(policy).toMatchObject({
      kind: "withhold",
      // A suppression, not an error: nothing failed, and populating
      // invoiceEmailError would make every staging invoice run report PARTIAL.
      suppressedForNonProduction: true,
      error: null,
    });
    if (policy.kind !== "withhold") throw new Error("unreachable");
    // The reason says WHY a capture does not help here, because "this is a copy"
    // alone would read as a contradiction beside a mailer that does send.
    expect(policy.logMessage).toContain("Xero");
    expect(policy.logMessage).toContain("real address");
  });

  it("withholds as a FAULT when the installation is undeclared", async () => {
    undeclareEnvironmentRole();
    const policy = await resolveXeroInvoiceEmailPolicy();
    expect(policy).toMatchObject({ kind: "withhold", suppressedForNonProduction: false });
    if (policy.kind !== "withhold") throw new Error("unreachable");
    expect(policy.error).toBeInstanceOf(Error);
  });
});

describe("sendXeroInvoiceEmail", () => {
  it("calls the provider once, with the caller's idempotency key", async () => {
    declareEnvironmentRole("production");
    const policy = await resolveXeroInvoiceEmailPolicy();
    if (policy.kind !== "allow") throw new Error("unreachable");

    const result = await sendXeroInvoiceEmail({
      clearance: policy.clearance,
      xero: { accountingApi: { emailInvoice: mocks.emailInvoice } },
      tenantId: "tenant-1",
      invoiceId: "invoice-1",
      idempotencyKey: "booking:bk_1:invoice-email:invoice-1:v1",
      workflow: "test",
      context: "test",
    });

    expect(result).toEqual({ body: { sent: true } });
    expect(mocks.emailInvoice).toHaveBeenCalledTimes(1);
    expect(mocks.emailInvoice).toHaveBeenCalledWith(
      "tenant-1",
      "invoice-1",
      expect.anything(),
      "booking:bk_1:invoice-email:invoice-1:v1",
    );
  });

  it("refuses a GENUINE capture clearance rather than calling the provider", async () => {
    /*
      THE ONE ARGUMENT THE WHOLE TWO-BRAND DESIGN RESTS ON, and before #3035's
      review NO test discriminated it. Mutating the wrapper's
      `assertDeliveryClearanceWitness(params.clearance, "production")` to `"any"` —
      which lets a capture-declared copy open the real Xero send — passed 218/218
      across the nine relevant suites and 127/127 across every file naming
      `clearance` or `xero-invoice-email`. One test exercised the assertion
      directly; the other presented a forged `{} as never` token that fails the
      FIRST check regardless of the required grounds.

      This one presents a REAL capture clearance, minted by the real policy on an
      installation that really is a declared capture copy, and demands the wrapper
      refuse it. A capture mailbox intercepts the mail this application sends
      itself; Xero sends an invoice from its own servers to the address stored on
      the member's contact, so no capture container ever sees it.

      The `as never` is the type-level half being deliberately defeated so the
      RUNTIME half can be tested: `DeliveryClearance` is not assignable to
      `LiveProviderClearance`, which is what stops this in real code.
    */
    declareEnvironmentRole("non-production");
    declareCaptureTransport();
    const capture = await resolveDeliveryPolicy();
    expect(capture).toMatchObject({
      kind: "allow",
      grounds: "non-production-capture",
    });
    if (capture.kind !== "allow") throw new Error("unreachable");

    await expect(
      sendXeroInvoiceEmail({
        clearance: capture.clearance as never,
        xero: { accountingApi: { emailInvoice: mocks.emailInvoice } },
        tenantId: "tenant-1",
        invoiceId: "invoice-1",
        idempotencyKey: "k",
        workflow: "test",
        context: "test",
      }),
    ).rejects.toThrow(/local capture mailbox/);
    expect(mocks.emailInvoice).not.toHaveBeenCalled();
  });

  it("refuses a forged clearance rather than calling the provider", async () => {
    // The cast escape hatch, closed at runtime. The type already refuses this;
    // this is what happens when somebody casts past the type.
    await expect(
      sendXeroInvoiceEmail({
        clearance: {} as never,
        xero: { accountingApi: { emailInvoice: mocks.emailInvoice } },
        tenantId: "tenant-1",
        invoiceId: "invoice-1",
        idempotencyKey: "k",
        workflow: "test",
        context: "test",
      }),
    ).rejects.toThrow(/did not present a delivery clearance/);
    expect(mocks.emailInvoice).not.toHaveBeenCalled();
  });
});
