/**
 * #5433 (round 3, item 2): the email retry job asks "is this email still
 * wanted?" before it claims a row, for templates that register a check
 * (`email/retry-still-wanted.ts`). A waitlist offer email whose offer has
 * ended is retired, not sent; one whose offer is live replays as before. The
 * job's own suite (`cron-email-retry.test.ts`) runs unchanged, which is the
 * proof that templates with no check are untouched. Setup copied from it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  bookingFindUnique: vi.fn(),
  // #3071: controllable per call, so a test can have an administrator switch the
  // safer override on WHILE a batch is running.
  environmentSafetyFindUnique: vi.fn(),
  findMany: vi.fn(),
  update: vi.fn(),
  updateMany: vi.fn(),
  memberFindMany: vi.fn(),
  memberFindUnique: vi.fn(),
  sendMail: vi.fn(),
  resolveEmailDeliveryConfig: vi.fn(),
  // #3035: the delivery policy reads the DECLARED transport kind through this
  // same canonical parser, so a partial mock of the module has to name it or the
  // whole file dies at import.
  resolveEmailTransportKind: vi.fn(() => "live-provider"),
  sendEmail: vi.fn(),
  getAdminEmails: vi.fn(),
  getActiveEmailSuppression: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    environmentSafetySettings: {
      findUnique: mocks.environmentSafetyFindUnique,
    },
    emailLog: {
      findMany: mocks.findMany,
      update: mocks.update,
      updateMany: mocks.updateMany,
    },
    member: {
      findMany: mocks.memberFindMany,
      findUnique: mocks.memberFindUnique,
    },
    // #2258: the retry cron re-reads the booking's "No emails" switch before
    // every replay.
    booking: {
      findUnique: mocks.bookingFindUnique,
    },
  },
}));

vi.mock("@/lib/email-suppression", () => ({
  getActiveEmailSuppression: mocks.getActiveEmailSuppression,
  normalizeEmailAddress: (value: string) => value.trim().toLowerCase(),
}));

vi.mock("nodemailer", () => ({
  default: {
    createTransport: vi.fn(() => ({ sendMail: mocks.sendMail })),
  },
}));

vi.mock("@/lib/email-sender", () => ({
  EMAIL_FROM: "noreply@example.test",
  formatEmailFromAddress: (from: string) => from,
}));

vi.mock("@/lib/email-text", () => ({
  htmlToPlainText: (html: string) => html,
}));

vi.mock("@/lib/email-delivery", () => ({
  resolveEmailDeliveryConfig: mocks.resolveEmailDeliveryConfig,
  resolveEmailTransportKind: mocks.resolveEmailTransportKind,
}));

vi.mock("@/lib/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/email", () => ({
  sendEmail: mocks.sendEmail,
  // #2548: the retry-exhausted alert resolves its audience through the shared
  // access-role-aware helper instead of querying the legacy ADMIN scalar here.
  getAdminEmails: mocks.getAdminEmails,
}));

import { retryFailedEmails } from "@/lib/cron-email-retry";
import { declareEnvironmentRole } from "@/lib/__tests__/helpers/environment-role";

function failedEmail(overrides: Record<string, unknown> = {}) {
  return {
    id: "email_1",
    to: "member@example.test",
    subject: "Booking update",
    htmlBody: "<p>hello</p>",
    templateName: "booking-confirmed",
    // #2258: rows written since the migration carry their booking. The
    // NULL-bookingId cases (pre-migration rows) are exercised explicitly below.
    bookingId: "bk_1",
    bookingRecipientMemberId: "member_1",
    bookingBodyOverrideApplied: false,
    bookingDetailLinkIncluded: false,
    bookingRetryHtmlBody: null,
    attempts: 0,
    ...overrides,
  };
}

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
  // No override, the ordinary state of an installation that has never used the
  // safer switch. `vi.clearAllMocks()` in the describes below clears calls, not
  // implementations, so this survives into every test.
  mocks.environmentSafetyFindUnique.mockResolvedValue(null);
});

describe("the retry job asks a template's still-wanted check before it claims (#5433 round 3, item 2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveEmailDeliveryConfig.mockReturnValue({
      ok: true,
      mode: "smtp-relay",
      modeSource: "explicit-flag",
      modeLabel: "SMTP Relay",
      // #3035: the retry cron now obtains its transport through
      // getEmailTransporter, which builds a cache signature from the auth pair
      // instead of reading transportOptions.host alone.
      transportOptions: {
        host: "smtp.example.test",
        port: 587,
        secure: false,
        auth: { user: "relay-user", pass: "relay-pass" },
      },
      issues: [],
      warnings: [],
    });
    mocks.update.mockResolvedValue({});
    mocks.updateMany.mockResolvedValue({ count: 1 });
    mocks.memberFindMany.mockResolvedValue([]);
    mocks.getAdminEmails.mockResolvedValue([]);
    mocks.getActiveEmailSuppression.mockResolvedValue(null);
    mocks.bookingFindUnique.mockImplementation(
      async (args: { select?: { noEmails?: boolean } }) =>
        args.select?.noEmails
          ? { noEmails: false }
          : { memberId: "member_1", deletedAt: null, guests: [] },
    );
    mocks.memberFindUnique.mockResolvedValue({
      email: "member@example.test",
      inheritEmailFromId: null,
      inheritEmailFrom: null,
      role: "USER",
      financeAccessLevel: "NONE",
      active: true,
      archivedAt: null,
      canLogin: true,
      accessRoles: [],
    });
  });

  const OFFERED_AT = new Date("2026-06-30T00:00:00.000Z");
  const OFFER_ROW_ID = `email:waitlist-offer:bk_1:${OFFERED_AT.getTime()}`;

  /** The booking as each reader asks for it: the "No emails" gate, the still-wanted check, the link authority. */
  function bookingIs(offer: { status: string; waitlistOfferedAt: Date | null } | null) {
    mocks.bookingFindUnique.mockImplementation(async (args: { select?: { noEmails?: boolean; status?: boolean } }) => {
      if (args.select?.noEmails) return { noEmails: false };
      if (args.select?.status) return offer;
      return { memberId: "member_1", deletedAt: null, guests: [] };
    });
  }

  const mockPrismaRows = (rows: unknown[]) => mocks.findMany.mockResolvedValue(rows);
  const offerEmail = () =>
    failedEmail({ id: OFFER_ROW_ID, templateName: "waitlist-offer", subject: "Spot Available!", htmlBody: null, bookingRetryHtmlBody: "<p>the offer</p>", attempts: 1 });

  it.each([
    ["confirmed", { status: "PAYMENT_PENDING", waitlistOfferedAt: null }],
    ["lapsed, declined or returned to the waitlist", { status: "WAITLISTED", waitlistOfferedAt: null }],
    ["cancelled", { status: "CANCELLED", waitlistOfferedAt: null }],
    ["re-offered (a different offer)", { status: "WAITLIST_OFFERED", waitlistOfferedAt: new Date(OFFERED_AT.getTime() + 60_000) }],
    ["deleted", null],
  ])("retires, and sends nothing, a waitlist offer email whose offer was %s", async (_case, offer) => {
    bookingIs(offer);
    mocks.findMany.mockResolvedValue([offerEmail()]);

    const result = await retryFailedEmails();

    expect(mocks.sendMail).not.toHaveBeenCalled();
    expect(result).toEqual({ retried: 0, succeeded: 0, failed: 0 });
    expect(mocks.updateMany).toHaveBeenCalledTimes(1);
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { id: OFFER_ROW_ID, status: "FAILED", attempts: 1, htmlBody: null, bookingRetryHtmlBody: "<p>the offer</p>" },
      data: expect.objectContaining({ attempts: 3, htmlBody: null, bookingRetryHtmlBody: null, errorMessage: expect.stringContaining("no longer wanted") }),
    });
  });

  it("replays a row the release before #5433 wrote (no key) while the booking is offered, as that release would (round 4, item 1)", async () => {
    bookingIs({ status: "WAITLIST_OFFERED", waitlistOfferedAt: OFFERED_AT });
    mockPrismaRows([{ ...offerEmail(), id: "clx0prerelease0000000000", createdAt: new Date(OFFERED_AT.getTime() + 1_000) }]);
    mocks.sendMail.mockResolvedValue({ messageId: "msg_1" });

    const result = await retryFailedEmails();

    expect(result).toEqual({ retried: 1, succeeded: 1, failed: 0 });
    expect(mocks.sendMail).toHaveBeenCalledTimes(1);
  });

  it("retires a row the release before #5433 wrote when it predates the booking's current offer (round 5, F2)", async () => {
    bookingIs({ status: "WAITLIST_OFFERED", waitlistOfferedAt: OFFERED_AT });
    mockPrismaRows([{ ...offerEmail(), id: "clx0prerelease0000000000", createdAt: new Date(OFFERED_AT.getTime() - 86_400_000) }]);

    await retryFailedEmails();

    expect(mocks.sendMail).not.toHaveBeenCalled();
    expect(mocks.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ errorMessage: expect.stringContaining("predates") }) }));
  });

  it("retires a row the release before #5433 wrote once its booking is no longer offered", async () => {
    bookingIs({ status: "WAITLISTED", waitlistOfferedAt: null });
    mockPrismaRows([{ ...offerEmail(), id: "clx0prerelease0000000000" }]);

    await retryFailedEmails();

    expect(mocks.sendMail).not.toHaveBeenCalled();
    expect(mocks.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: "clx0prerelease0000000000", status: "FAILED" }) }));
  });

  it("replays a waitlist offer email whose offer is still the live one", async () => {
    bookingIs({ status: "WAITLIST_OFFERED", waitlistOfferedAt: OFFERED_AT });
    mocks.findMany.mockResolvedValue([offerEmail()]);
    mocks.sendMail.mockResolvedValue({ messageId: "msg_1" });

    const result = await retryFailedEmails();

    expect(result).toEqual({ retried: 1, succeeded: 1, failed: 0 });
    expect(mocks.sendMail).toHaveBeenCalledTimes(1);
  });

  it("leaves the row as found, sending nothing, when the check cannot read the booking", async () => {
    mocks.bookingFindUnique.mockImplementation(async (args: { select?: { noEmails?: boolean; status?: boolean } }) => {
      if (args.select?.noEmails) return { noEmails: false };
      if (args.select?.status) throw new Error("db down");
      return { memberId: "member_1", deletedAt: null, guests: [] };
    });
    mocks.findMany.mockResolvedValue([offerEmail()]);

    await retryFailedEmails();

    expect(mocks.sendMail).not.toHaveBeenCalled();
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });
});
