import { beforeEach, describe, expect, it, vi } from "vitest";
import { CLUB_FORMAT_TEST } from "../../__tests__/support/club-format-fixture";

/*
  #5433 PR 3: the booking confirmation's sender passes an owed notice's event key
  through to `sendEmail`, which makes it the `EmailLog` row's id
  (`email:booking-confirmed:<key>`), so a recovered send finds the first one's
  row and the member is never sent it twice. Every other caller sends no key,
  and its `sendEmail` call carries no `idempotencyKey` at all, as before.
*/

const { sendEmailMock, loadLodgeSettingsMock, loadAppliedCreditMock, resolveBookingEmailLinkMock } = vi.hoisted(() => ({
  sendEmailMock: vi.fn().mockResolvedValue({ status: "sent", emailLogId: "row", messageId: null }),
  loadLodgeSettingsMock: vi.fn(),
  loadAppliedCreditMock: vi.fn(),
  resolveBookingEmailLinkMock: vi.fn(),
}));

vi.mock("@/lib/email/core", () => ({ sendEmail: sendEmailMock }));
vi.mock("@/lib/logger", () => ({ default: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/booking-confirmation-credit", () => ({ loadBookingAppliedCredit: loadAppliedCreditMock }));
vi.mock("@/lib/booking-email-authority", () => ({ resolveBookingEmailLink: resolveBookingEmailLinkMock }));
vi.mock("@/lib/email-message-settings", () => ({
  EMAIL_DEFAULT_LODGE_NAME: "Example Club Lodge",
  EMAIL_DEFAULT_FROM_NAME: "Example Club - Online Booking System",
  loadEmailMessageSettingsForLodge: loadLodgeSettingsMock,
  loadEmailMessageSettings: vi.fn(),
  applyEmailMessageSettingsToHtml: vi.fn((html: string) => html),
  applyEmailMessageSettingsToSubject: vi.fn((subject: string) => subject),
  buildEmailTemplateGlobalData: vi.fn(() => ({})),
}));

beforeEach(() => {
  vi.clearAllMocks();
  loadLodgeSettingsMock.mockResolvedValue({ lodgeName: "Example Club Lodge", lodgeTravelNote: null, doorCode: null });
  loadAppliedCreditMock.mockResolvedValue({ amountCents: 0, settlementMethod: "card" });
  resolveBookingEmailLinkMock.mockResolvedValue(null);
});

async function send(context: { bookingId: string; recipientMemberId: string | null; idempotencyKey?: string }) {
  const { sendBookingConfirmedEmail } = await import("@/lib/email/booking");
  await sendBookingConfirmedEmail(context, "member@example.org", "Sam", new Date("2026-08-15"), new Date("2026-08-17"), 2, 20_000, CLUB_FORMAT_TEST, { lodgeId: "lodge-1" });
  return sendEmailMock.mock.calls[0]![0] as Record<string, unknown>;
}

describe("sendBookingConfirmedEmail's event key (#5433 PR 3)", () => {
  it("passes an owed notice's key to sendEmail, under the confirmation's template name", async () => {
    const call = await send({ bookingId: "bk_1", recipientMemberId: "m_1", idempotencyKey: "bk_1:1782864000000" });

    expect(call).toMatchObject({ templateName: "booking-confirmed", idempotencyKey: "bk_1:1782864000000" });
  });

  it("sends no key at all for every other caller, as before", async () => {
    const call = await send({ bookingId: "bk_1", recipientMemberId: "m_1" });

    expect(call).not.toHaveProperty("idempotencyKey");
    expect(call).toMatchObject({ templateName: "booking-confirmed" });
  });
});
