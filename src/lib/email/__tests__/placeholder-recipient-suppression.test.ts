import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  emailLogCreate: vi.fn(),
  emailLogUpdate: vi.fn(),
  getActiveEmailSuppression: vi.fn(),
  sendMail: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    environmentSafetySettings: { findUnique: vi.fn().mockResolvedValue(null) },
    emailLog: { create: mocks.emailLogCreate, update: mocks.emailLogUpdate },
  },
}));
vi.mock("@/lib/logger", () => ({ default: mocks.logger }));
vi.mock("@/lib/email-sender", () => ({ EMAIL_FROM: "club@club.test" }));
vi.mock("@/lib/email-message-settings", () => ({
  formatEmailFromAddressWithSettings: () => "Club <club@club.test>",
}));
vi.mock("@/lib/email-message-renderer", () => ({
  prepareEmailMessage: async ({ subject, html }: { subject: string; html: string }) => ({
    subject,
    html,
    settings: {},
  }),
}));
vi.mock("@/lib/email-suppression", () => ({
  getActiveEmailSuppression: mocks.getActiveEmailSuppression,
  normalizeEmailAddress: (value: string) => value.trim().toLowerCase(),
}));
vi.mock("@/lib/email/internal", () => ({
  getEmailTransporter: () => ({ sendMail: mocks.sendMail }),
  shouldPersistEmailHtml: () => false,
  // #3035: `sendEmail` names which transport carried a delivered message
  // through this helper, so a factory that omits it dies at import.
  logDeliveredTransport: () => {},
}));

import { sendEmail } from "@/lib/email/core";
import { buildPlaceholderContactEmail } from "@/lib/placeholder-contact-email";
import { declareEnvironmentRole } from "@/lib/__tests__/helpers/environment-role";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.emailLogCreate.mockResolvedValue({ id: "log_1" });
  mocks.emailLogUpdate.mockResolvedValue({});
  mocks.getActiveEmailSuppression.mockResolvedValue(null);
  // Dev short-circuit marks SENT without a real transporter — enough to prove
  // a real recipient reaches the EmailLog + suppression path.
  vi.stubEnv("NODE_ENV", "development");
});

/*
  #3035 (ENV-SAFETY 2): this suite exercises a real SEND, so it has to say which
  installation it is pretending to be. `resolveEnvironmentRole()` answers from the
  APP_ENVIRONMENT_ROLE declaration AND the EnvironmentSafetySettings row, and both
  are absent by default in the unit suite — a missing Prisma delegate is an
  UNREADABLE override, not "no override", so the role resolves UNKNOWN and the
  delivery boundary withholds every message. Declaring production plus a
  no-override delegate is what makes these tests exercise live behaviour.
  See src/lib/__tests__/helpers/environment-role.ts.
*/
beforeEach(() => {
  declareEnvironmentRole("production");
});

describe("sendEmail placeholder recipient suppression (#1935)", () => {
  it("never sends to a walk-in placeholder owner and creates no EmailLog row", async () => {
    const outcome = await sendEmail({
      bookingContext: "none",
      to: buildPlaceholderContactEmail(),
      subject: "Your booking is on hold",
      html: "<p>hold</p>",
      templateName: "booking-pending",
    });

    expect(outcome.status).toBe("skipped_placeholder_recipient");
    expect(mocks.emailLogCreate).not.toHaveBeenCalled();
    expect(mocks.getActiveEmailSuppression).not.toHaveBeenCalled();
    expect(mocks.sendMail).not.toHaveBeenCalled();
  });

  it("still processes a real recipient normally", async () => {
    const outcome = await sendEmail({
      bookingContext: "none",
      to: "real.person@example.com",
      subject: "Your booking is on hold",
      html: "<p>hold</p>",
      templateName: "booking-pending",
    });

    expect(outcome.status).not.toBe("skipped_placeholder_recipient");
    // A real recipient reaches the suppression check + EmailLog creation.
    expect(mocks.emailLogCreate).toHaveBeenCalled();
    expect(mocks.getActiveEmailSuppression).toHaveBeenCalled();
  });
});
