import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * #5407 item 37: the Xero sync error alert's hourly limit is an `AlertCooldown`
 * claim on one key, settled by the sequence the repeated-failure alert shares
 * (`sendAdminAlertOncePerWindow`). The real claim, defer and release in
 * `alert-cooldown.ts` run against an in-memory table, as in
 * `xero-hardening.test.ts`.
 */
const mocks = vi.hoisted(() => ({
  cooldowns: new Map<string, Date>(),
  cooldownUpdateMany: vi.fn(),
  emailFindFirst: vi.fn(),
  sendSyncErrorAlert: vi.fn(),
  loggerInfo: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    // The old limit read the mail log; nothing may read it now.
    emailLog: { findFirst: mocks.emailFindFirst },
    alertCooldown: {
      updateMany: mocks.cooldownUpdateMany,
      create: async ({ data }: { data: { key: string; lastAlertedAt: Date } }) => {
        if (mocks.cooldowns.has(data.key)) {
          throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
        }
        mocks.cooldowns.set(data.key, data.lastAlertedAt);
        return data;
      },
      deleteMany: async ({ where }: { where: { key: string; lastAlertedAt: Date } }) => {
        const held = mocks.cooldowns.get(where.key);
        if (!held || held.getTime() !== where.lastAlertedAt.getTime()) return { count: 0 };
        mocks.cooldowns.delete(where.key);
        return { count: 1 };
      },
    },
  },
}));

vi.mock("@/lib/email", () => ({
  sendAdminXeroSyncErrorAlert: mocks.sendSyncErrorAlert,
}));

vi.mock("@/lib/logger", () => ({
  default: { error: mocks.loggerError, info: mocks.loggerInfo, warn: vi.fn(), debug: vi.fn() },
}));

import { notifyXeroSyncError } from "@/lib/xero-error-alert";
import { XERO_SYNC_ERROR_ALERT_COOLDOWN_KEY } from "@/lib/xero-sync-error-alert-key";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const KEY = XERO_SYNC_ERROR_ALERT_COOLDOWN_KEY;

const sendResult = (overrides: Record<string, unknown> = {}) => ({
  deliveryAllowed: true,
  recipients: 1,
  sent: 1,
  queuedForRetry: 0,
  notDelivered: 0,
  failedBeforeLogged: 0,
  ...overrides,
});

const alert = (errorType = "API Error", operation = "createInvoice") =>
  notifyXeroSyncError({ errorType, operation, errorMessage: "Rate limit exceeded" });

describe("notifyXeroSyncError: one alert an hour, held by an AlertCooldown claim (#5407 item 37)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.cooldowns.clear();
    mocks.sendSyncErrorAlert.mockResolvedValue(sendResult());
    mocks.cooldownUpdateMany.mockImplementation(
      async ({
        where,
        data,
      }: {
        where: { key: string; lastAlertedAt: { lt: Date } | Date };
        data: { lastAlertedAt: Date };
      }) => {
        const held = mocks.cooldowns.get(where.key);
        // A claim matches an older stamp (`lt`); a defer or release its own stamp.
        const matches =
          where.lastAlertedAt instanceof Date
            ? held?.getTime() === where.lastAlertedAt.getTime()
            : held !== undefined && held.getTime() < where.lastAlertedAt.lt.getTime();
        if (!matches) return { count: 0 };
        mocks.cooldowns.set(where.key, data.lastAlertedAt);
        return { count: 1 };
      }
    );
  });

  it("sends the first alert and holds the hour on the one global key", async () => {
    await alert();

    expect(mocks.sendSyncErrorAlert).toHaveBeenCalledTimes(1);
    expect(mocks.sendSyncErrorAlert).toHaveBeenCalledWith(
      expect.objectContaining({ errorType: "API Error", operation: "createInvoice" })
    );
    expect([...mocks.cooldowns.entries()]).toEqual([[KEY, new Date(Date.now())]]);
    expect(mocks.emailFindFirst).not.toHaveBeenCalled();
  });

  it("limits every error type and operation together, as before: one alert an hour in all", async () => {
    await alert("API Error", "createInvoice");
    await alert("Token refresh failed", "refreshToken");
    await alert("API Error", "createInvoice");

    expect(mocks.sendSyncErrorAlert).toHaveBeenCalledTimes(1);
    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      { operation: "refreshToken" },
      "Xero error alert suppressed (window held)"
    );
  });

  it("alerts again once the last alert is more than an hour old", async () => {
    mocks.cooldowns.set(KEY, new Date(Date.now() - HOUR_MS - 1));

    await alert();

    expect(mocks.sendSyncErrorAlert).toHaveBeenCalledTimes(1);
  });

  it("does not alert while an alert raised exactly an hour ago still holds the window", async () => {
    mocks.cooldowns.set(KEY, new Date(Date.now() - HOUR_MS));

    await alert();

    expect(mocks.sendSyncErrorAlert).not.toHaveBeenCalled();
  });

  it.each([
    ["sent", sendResult()],
    ["queued for the retry cron (FAILED with its body kept)", sendResult({ sent: 0, queuedForRetry: 1 })],
    ["withheld on a copy or bounced (SKIPPED_NON_PRODUCTION, BOUNCED)", sendResult({ sent: 0, notDelivered: 1 })],
  ])("keeps the hour once the alert was RAISED, not just delivered: %s (#3035)", async (_label, result) => {
    mocks.sendSyncErrorAlert.mockResolvedValue(result);

    await alert();
    await alert();

    expect(mocks.sendSyncErrorAlert).toHaveBeenCalledTimes(1);
    expect(mocks.cooldowns.get(KEY)?.getTime()).toBe(Date.now());
  });

  it.each([
    ["the delivery policy skipped it", sendResult({ deliveryAllowed: false, recipients: 0, sent: 0 })],
    ["no admin is opted in", sendResult({ recipients: 0, sent: 0 })],
  ])("holds the claim for a day, not an hour, when nobody could receive it: %s (#3635 F1)", async (_label, result) => {
    mocks.sendSyncErrorAlert.mockResolvedValue(result);

    await alert();
    await alert();

    expect(mocks.sendSyncErrorAlert).toHaveBeenCalledTimes(1);
    // Stamped so a one-hour claim succeeds again exactly one day after this one.
    expect(mocks.cooldowns.get(KEY)?.getTime()).toBe(Date.now() - HOUR_MS + DAY_MS);
  });

  it("holds the claim for the hour only when every copy failed before its mail log row existed", async () => {
    // A transient mail fault, not a setting: a different error an hour on is
    // reported, not shut out for a day.
    mocks.sendSyncErrorAlert.mockResolvedValue(sendResult({ sent: 0, notDelivered: 1, failedBeforeLogged: 1 }));

    await alert();
    await alert("Token refresh failed", "refreshToken");

    expect(mocks.sendSyncErrorAlert).toHaveBeenCalledTimes(1);
    // Stamped so a one-hour claim succeeds again exactly one hour after this one.
    expect(mocks.cooldowns.get(KEY)?.getTime()).toBe(Date.now());

    mocks.cooldowns.set(KEY, new Date(Date.now() - HOUR_MS - 1));
    await alert("Token refresh failed", "refreshToken");
    expect(mocks.sendSyncErrorAlert).toHaveBeenCalledTimes(2);
  });

  it("gives the claim back when the send throws, so the next error alerts", async () => {
    mocks.sendSyncErrorAlert.mockRejectedValueOnce(new Error("render failed"));

    await alert();
    expect(mocks.cooldowns.has(KEY)).toBe(false);
    expect(mocks.loggerError).toHaveBeenCalledWith(
      { err: expect.objectContaining({ message: "render failed" }) },
      "Failed to send Xero sync error alert"
    );

    await alert();
    expect(mocks.sendSyncErrorAlert).toHaveBeenCalledTimes(2);
  });

  it("sends nothing and never throws when the claim throws, giving back a stamp that may have landed", async () => {
    mocks.cooldownUpdateMany.mockImplementationOnce(async ({ data }: { data: { lastAlertedAt: Date } }) => {
      // The write committed, then the connection dropped before the reply.
      mocks.cooldowns.set(KEY, data.lastAlertedAt);
      throw new Error("database unavailable");
    });

    await expect(alert()).resolves.toBeUndefined();
    expect(mocks.sendSyncErrorAlert).not.toHaveBeenCalled();
    expect(mocks.cooldowns.has(KEY)).toBe(false);
    expect(mocks.loggerError).toHaveBeenCalledWith(
      { err: expect.objectContaining({ message: "database unavailable" }) },
      "Failed to send Xero sync error alert"
    );
  });

  it("redacts the error message before it is sent", async () => {
    await notifyXeroSyncError({
      errorType: "API Error",
      operation: "createInvoice",
      errorMessage: "Xero failed with access_token=live-access",
    });

    const sent = mocks.sendSyncErrorAlert.mock.calls[0][0] as { errorMessage: string };
    expect(sent.errorMessage).toContain("access_token=[REDACTED]");
    expect(sent.errorMessage).not.toContain("live-access");
  });
});
