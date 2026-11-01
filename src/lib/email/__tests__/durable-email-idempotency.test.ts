import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  create: vi.fn(), findUnique: vi.fn(), update: vi.fn(), sendMail: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: { emailLog: {
  create: mocks.create, findUnique: mocks.findUnique, update: mocks.update,
} } }));
vi.mock("@/lib/logger", () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/email-sender", () => ({ EMAIL_FROM: "club@example.org" }));
vi.mock("@/lib/email-message-settings", () => ({ formatEmailFromAddressWithSettings: () => "Club <club@example.org>" }));
vi.mock("@/lib/email-message-renderer", () => ({
  prepareEmailMessage: async ({ subject, html }: { subject: string; html: string }) => ({ subject, html, settings: {}, bodyOverrideApplied: false }),
}));
vi.mock("@/lib/email-suppression", () => ({
  getActiveEmailSuppression: async () => null,
  normalizeEmailAddress: (value: string) => value.trim().toLowerCase(),
}));
vi.mock("@/lib/booking-email-authority", () => ({ resolveBookingEmailLink: async () => ({ bookingUrl: null }) }));
vi.mock("@/lib/booking-email-suppression", () => ({ resolveBookingEmailGate: async () => ({ decision: "send" }) }));
vi.mock("@/lib/email/environment-gate", () => ({ resolveEmailEnvironmentGate: async () => ({ decision: "send", clearance: {} }) }));
vi.mock("@/lib/email/internal", () => ({
  getEmailTransporter: async () => ({ transporter: { sendMail: mocks.sendMail }, modeLabel: "test" }),
  shouldPersistEmailHtml: () => true,
  logDeliveredTransport: () => {},
}));

import { sendEmail } from "@/lib/email/core";

const params = {
  to: "organiser@example.org", subject: "Extra invoice", html: "<p>INV-42: $65.00</p>",
  templateName: "group-organiser-extra-invoice", idempotencyKey: "change-1",
  bookingContext: { bookingId: "organiser-booking", recipient: { kind: "member" as const, memberId: "organiser-member" } },
};
const LOG_ID = "email:group-organiser-extra-invoice:change-1";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NODE_ENV", "test");
  mocks.create.mockResolvedValue({ id: LOG_ID });
  mocks.findUnique.mockResolvedValue({ id: LOG_ID });
  mocks.update.mockResolvedValue({});
  mocks.sendMail.mockResolvedValue({ messageId: "message-1" });
});

describe("durable email event identity", () => {
  it("durably queues a deferred notice for the retry worker without an initial SMTP send", async () => {
    await expect(sendEmail({ ...params, deferDelivery: true })).resolves.toEqual({ status: "queued", emailLogId: LOG_ID });
    expect(mocks.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      id: LOG_ID, status: "FAILED", lastAttemptAt: new Date(),
      errorMessage: "Delivery pending; queued for the email retry worker",
      bookingRetryHtmlBody: expect.stringContaining("INV-42"),
    }) });
    expect(mocks.sendMail).not.toHaveBeenCalled();
    mocks.create.mockRejectedValueOnce({ code: "P2002" });
    await expect(sendEmail({ ...params, deferDelivery: true })).resolves.toEqual({ status: "already_recorded", emailLogId: LOG_ID });
    expect(mocks.sendMail).not.toHaveBeenCalled();
  });

  it.each([
    { idempotencyKey: "" },
    { logRecipient: "redacted@example.org" },
    { attachments: [{ filename: "invoice.pdf", content: Buffer.from("invoice") }] },
  ])("rejects deferred mail the existing retry worker cannot recover: %j", async (unsupported) => {
    await expect(sendEmail({ ...params, ...unsupported, deferDelivery: true })).rejects.toThrow("Deferred email requires");
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.sendMail).not.toHaveBeenCalled();
  });

  it("persists a deterministic event id with the organiser's retry identity before sending", async () => {
    await expect(sendEmail(params)).resolves.toMatchObject({ status: "sent", emailLogId: LOG_ID });
    expect(mocks.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      id: LOG_ID, status: "QUEUED", bookingId: "organiser-booking",
      bookingRecipientMemberId: "organiser-member", bookingBodyOverrideApplied: false,
      bookingRetryHtmlBody: expect.stringContaining("INV-42"), htmlBody: null,
    }) });
    expect(mocks.sendMail).toHaveBeenCalledTimes(1);
  });

  it("leaves a provider failure retryable, then suppresses another business re-drive", async () => {
    mocks.sendMail.mockRejectedValueOnce(new Error("provider down"));
    await expect(sendEmail(params)).rejects.toThrow("provider down");
    expect(mocks.update).toHaveBeenCalledWith({ where: { id: LOG_ID }, data: { status: "FAILED", errorMessage: "provider down" } });
    mocks.create.mockRejectedValueOnce({ code: "P2002" });
    await expect(sendEmail(params)).resolves.toEqual({ status: "already_recorded", emailLogId: LOG_ID });
    expect(mocks.sendMail).toHaveBeenCalledTimes(1);
  });

  it("requires the exact event row before treating a unique conflict as a duplicate", async () => {
    const error = { code: "P2002", meta: { target: ["other"] } };
    mocks.create.mockRejectedValueOnce(error);
    mocks.findUnique.mockResolvedValueOnce(null);
    await expect(sendEmail(params)).rejects.toBe(error);
    expect(mocks.findUnique).toHaveBeenCalledWith({ where: { id: LOG_ID }, select: { id: true } });
    expect(mocks.sendMail).not.toHaveBeenCalled();
  });

  it("fails before delivery if durable logging is unavailable, allowing the next invoice retry to send", async () => {
    mocks.create.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(sendEmail(params)).rejects.toThrow("database unavailable");
    expect(mocks.sendMail).not.toHaveBeenCalled();
    await expect(sendEmail(params)).resolves.toMatchObject({ status: "sent" });
    expect(mocks.sendMail).toHaveBeenCalledTimes(1);
  });

  it("sends only once when concurrent invoice re-drives race for the event row", async () => {
    mocks.create.mockResolvedValueOnce({ id: LOG_ID }).mockRejectedValueOnce({ code: "P2002" });
    const outcomes = await Promise.all([sendEmail(params), sendEmail(params)]);
    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(["already_recorded", "sent"]);
    expect(mocks.sendMail).toHaveBeenCalledTimes(1);
  });
});
