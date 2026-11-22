import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAlertCooldownStore } from "./support/alert-cooldown-store";

/*
 * #5407 review: whether the officers' booking-bumped alert stays owed is
 * decided by what each officer's copy did, through the REAL alert sender,
 * `sendToAdmins` and its per-recipient isolation. Only the email core
 * (`sendEmail`) and the stores are doubles. A copy that fails before its
 * EmailLog row exists leaves nothing for the email retry cron, so the marker
 * stays and a later sweep sends the alert; a copy that fails after its FAILED
 * row was written is the retry cron's; nobody to tell is final.
 */

const mocks = vi.hoisted(() => ({
  sendEmail: vi.fn(),
  memberFindMany: vi.fn(),
  bookingFindUnique: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
const cooldown = createAlertCooldownStore();

vi.mock("@/lib/email/core", () => ({ sendEmail: (...args: unknown[]) => mocks.sendEmail(...args) }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    get alertCooldown() {
      return cooldown.delegate;
    },
    member: { findMany: (...args: unknown[]) => mocks.memberFindMany(...args) },
    booking: { findUnique: (...args: unknown[]) => mocks.bookingFindUnique(...args) },
    bookingEvent: { findFirst: vi.fn(async () => null) },
    lodge: {
      findUnique: vi.fn(async () => ({ name: "Ruapehu Lodge", active: true })),
      count: vi.fn(async () => 2),
    },
  },
}));
vi.mock("@/lib/notification-delivery-policies", () => ({
  shouldSendAdminSystemEmail: vi.fn(async () => ({ send: true, mode: "always" })),
}));
vi.mock("@/lib/email-admin-alert-escalation", () => ({
  recordAdminAlertDeliveryEscalation: vi.fn(async () => {}),
}));
vi.mock("@/lib/email-theme", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/email-theme")),
  renderEmailHtml: async <T,>(build: () => T) => build(),
}));
vi.mock("@/lib/logger", () => ({ default: mocks.logger }));

import {
  BUMP_NOTICE_SWEEP_AFTER_MS,
  bumpNoticeOwedKey,
  deliverBumpNotice,
  drainOwedBumpNotices,
} from "@/lib/booking-bump-notice-owed";

const BUMPED_AT = new Date();
const OWED = { bookingId: "b1", bumpedAt: BUMPED_AT, flagged: false };
const OFFICER_KEY = bumpNoticeOwedKey("officers", "b1", BUMPED_AT, false);

const booking = {
  id: "b1",
  status: "CANCELLED",
  lodgeId: "lodge-1",
  checkIn: new Date("2026-07-15"),
  checkOut: new Date("2026-07-17"),
  memberId: "member-1",
  member: { id: "member-1", email: "jane@example.org", firstName: "Jane", lastName: "Doe", canLogin: true },
  organisation: null,
  guests: [{ id: "g1" }],
};

function officer(email: string) {
  return {
    email,
    canLogin: true,
    accessRoles: [{ role: "ADMIN", roleDefinitionId: null, roleDefinition: null }],
    notificationPreference: null,
  };
}

/** The email core failing before it writes a copy's EmailLog row. */
async function failsBeforeTheRow() {
  throw new Error("message settings unreadable");
}

/** The email core writing the copy's row, then failing at the provider (the row is FAILED). */
async function failsAfterTheRow({ onAttemptLogged }: { onAttemptLogged?: (id: string) => void }) {
  onAttemptLogged?.("email-log-1");
  throw new Error("SMTP down");
}

beforeEach(() => {
  vi.clearAllMocks();
  cooldown.rows.clear();
  cooldown.rows.set(OFFICER_KEY, BUMPED_AT);
  mocks.memberFindMany.mockResolvedValue([officer("a@club.test"), officer("b@club.test")]);
  mocks.bookingFindUnique.mockResolvedValue(booking);
});

describe("the officers' bump alert stays owed only while nothing else will deliver it (#5407)", () => {
  it("keeps the marker when every copy fails before its row exists, and a later sweep sends it", async () => {
    mocks.sendEmail.mockImplementation(failsBeforeTheRow);

    await deliverBumpNotice("officers", booking as never, OWED);

    expect(mocks.sendEmail).toHaveBeenCalledTimes(2);
    expect(cooldown.rows.has(OFFICER_KEY)).toBe(true);

    mocks.sendEmail.mockReset();
    mocks.sendEmail.mockResolvedValue({ status: "sent", emailLogId: "log", messageId: "m" });
    const later = await drainOwedBumpNotices(new Date(BUMPED_AT.getTime() + 2 * BUMP_NOTICE_SWEEP_AFTER_MS));

    expect(later.delivered).toBe(1);
    expect(mocks.sendEmail).toHaveBeenCalledTimes(2);
    expect(mocks.sendEmail).toHaveBeenCalledWith(expect.objectContaining({ templateName: "admin-booking-bumped" }));
    expect(cooldown.rows.size).toBe(0);
  });

  it("clears the marker when the copies failed after their FAILED rows were written: the retry cron owns them", async () => {
    mocks.sendEmail.mockImplementation(failsAfterTheRow);

    await deliverBumpNotice("officers", booking as never, OWED);

    expect(mocks.sendEmail).toHaveBeenCalledTimes(2);
    expect(cooldown.rows.size).toBe(0);
  });

  it("keeps the marker when one copy failed before its row and the other was refused", async () => {
    mocks.sendEmail
      .mockImplementationOnce(failsBeforeTheRow)
      .mockResolvedValueOnce({ status: "suppressed", emailLogId: "log", emailSuppressionId: "s", reason: "bounced" });

    await deliverBumpNotice("officers", booking as never, OWED);

    expect(cooldown.rows.has(OFFICER_KEY)).toBe(true);
  });

  it("clears the marker when one officer received it, though another copy failed before its row", async () => {
    mocks.sendEmail
      .mockImplementationOnce(failsBeforeTheRow)
      .mockResolvedValueOnce({ status: "sent", emailLogId: "log", messageId: "m" });

    await deliverBumpNotice("officers", booking as never, OWED);

    expect(cooldown.rows.size).toBe(0);
  });

  it("clears the marker when there is no officer to tell", async () => {
    mocks.memberFindMany.mockResolvedValue([]);

    await deliverBumpNotice("officers", booking as never, OWED);

    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(cooldown.rows.size).toBe(0);
  });
});
