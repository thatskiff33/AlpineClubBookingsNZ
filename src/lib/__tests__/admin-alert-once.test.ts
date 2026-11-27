import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  claimAlertCooldown: vi.fn<(args: { key: string; windowMs: number; now: Date }) => Promise<boolean>>(),
  releaseAlertCooldown: vi.fn<(args: { key: string; claimedAt: Date }) => Promise<void>>(async () => {}),
  deferAlertCooldown: vi.fn(async () => {}),
  confirmAlertCooldownSend: vi.fn<(args: { key: string; claimedAt: Date }) => Promise<boolean>>(async () => true),
}));

vi.mock("@/lib/alert-cooldown", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/alert-cooldown")),
  claimAlertCooldown: mocks.claimAlertCooldown,
  releaseAlertCooldown: mocks.releaseAlertCooldown,
  deferAlertCooldown: mocks.deferAlertCooldown,
  confirmAlertCooldownSend: mocks.confirmAlertCooldownSend,
}));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/logger", () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { sendAdminAlertOnceEver, sendAdminAlertOnceEverClaim } from "@/lib/admin-alert-once";
import { takeOnceEverClaim } from "@/lib/once-ever-claim-context";
import { UNMUTEABLE_ALERT_SENT } from "@/lib/email/admin-alert-send-result";
import { FROZEN_TEST_CLOCK_BASE_ISO } from "./helpers/clock";

/**
 * #4679: what the once-ever helper reports about its claim. A claim call that
 * throws may still have committed its write, so the stamp it tried to write is
 * reported as uncertain rather than dropped; the boolean wrapper still answers
 * "not kept".
 */
describe("sendAdminAlertOnceEverClaim's claim report", () => {
  const send = vi.fn(async () => UNMUTEABLE_ALERT_SENT);
  const args = { key: "once:4679", label: "test alert", context: { id: "4679" }, send };
  const stampPassedToClaim = () => mocks.claimAlertCooldown.mock.calls[0][0].now;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.claimAlertCooldown.mockResolvedValue(true);
  });

  it("reports the stamp it tried to write, as uncertain, when the claim call throws, and sends nothing", async () => {
    mocks.claimAlertCooldown.mockRejectedValueOnce(new Error("Server has closed the connection."));

    const claim = await sendAdminAlertOnceEverClaim(args);

    expect(claim).toEqual({ kept: false, claimedAt: stampPassedToClaim(), claimUncertain: true });
    // The very Date passed to the claim, not a second clock read: the frozen
    // test clock makes two reads equal, while the stamp-guarded give-back in
    // production matches only the exact stamp written.
    expect(claim.claimedAt).toBe(stampPassedToClaim());
    expect(send).not.toHaveBeenCalled();
    expect(mocks.releaseAlertCooldown).not.toHaveBeenCalled();
  });

  it("keeps the boolean contract when the claim call throws: not kept", async () => {
    mocks.claimAlertCooldown.mockRejectedValueOnce(new Error("Server has closed the connection."));

    await expect(sendAdminAlertOnceEver(args)).resolves.toBe(false);
  });

  it("reports no stamp when another holder has the claim", async () => {
    mocks.claimAlertCooldown.mockResolvedValueOnce(false);

    await expect(sendAdminAlertOnceEverClaim(args)).resolves.toEqual({ kept: false, claimedAt: null, claimUncertain: false });
    expect(send).not.toHaveBeenCalled();
  });

  it("reports its certain stamp when it kept the claim, or gave it back after the send threw", async () => {
    await expect(sendAdminAlertOnceEverClaim(args)).resolves.toEqual({
      kept: true,
      claimedAt: stampPassedToClaim(),
      claimUncertain: false,
    });

    vi.clearAllMocks();
    send.mockRejectedValueOnce(new Error("mail down"));
    const claim = await sendAdminAlertOnceEverClaim(args);
    expect(claim).toEqual({ kept: false, claimedAt: stampPassedToClaim(), claimUncertain: false });
    expect(mocks.releaseAlertCooldown).toHaveBeenCalledWith({ key: "once:4679", claimedAt: stampPassedToClaim() });
  });
});

/**
 * #4696: the boolean wrapper gives back its own uncertain claim. A claim call
 * that throws may have committed its write; held, it would read as kept on
 * every later run and the once-ever alert would be lost. The store below keeps
 * one stamp per key, as `AlertCooldown` does, and gives back only an exact
 * stamp, as `releaseAlertCooldown` does.
 */
describe("sendAdminAlertOnceEver gives back an uncertain claim", () => {
  const key = "once:4696";
  const send = vi.fn(async () => UNMUTEABLE_ALERT_SENT);
  const args = { key, label: "test alert", context: { id: "4696" }, send };
  const held = new Map<string, Date>();
  let fault: "none" | "commits-then-throws" | "sibling-claims-meanwhile" = "none";
  const stampPassedToClaim = () => mocks.claimAlertCooldown.mock.calls[0][0].now;

  beforeEach(() => {
    vi.clearAllMocks();
    // A fault below moves the clock on; every case starts from the suite's frozen instant again.
    vi.setSystemTime(new Date(FROZEN_TEST_CLOCK_BASE_ISO));
    held.clear();
    fault = "none";
    mocks.claimAlertCooldown.mockImplementation(async ({ key: claimKey, now }) => {
      const injected = fault;
      fault = "none";
      if (injected === "commits-then-throws") {
        held.set(claimKey, now);
        // Time passes before the lost reply surfaces, so only the exact stamp written gives it back.
        vi.setSystemTime(Date.now() + 1);
        throw new Error("Server has closed the connection.");
      }
      if (injected === "sibling-claims-meanwhile") {
        // This call's write never landed; a sibling claims a millisecond later, under its own stamp.
        vi.setSystemTime(Date.now() + 1);
        held.set(claimKey, new Date());
        throw new Error("Server has closed the connection.");
      }
      if (held.has(claimKey)) return false;
      held.set(claimKey, now);
      return true;
    });
    mocks.releaseAlertCooldown.mockImplementation(async ({ key: releaseKey, claimedAt }) => {
      if (held.get(releaseKey)?.getTime() === claimedAt.getTime()) held.delete(releaseKey);
    });
  });

  afterEach(() => {
    mocks.releaseAlertCooldown.mockImplementation(async () => {});
  });

  it("gives back a claim that committed before its call threw, and the next call sends exactly once", async () => {
    fault = "commits-then-throws";

    await expect(sendAdminAlertOnceEver(args)).resolves.toBe(false);
    expect(send).not.toHaveBeenCalled();
    // The very Date written, not a second clock read: the clock has moved on.
    expect(mocks.releaseAlertCooldown.mock.calls[0][0].claimedAt).toBe(stampPassedToClaim());
    expect(held.has(key)).toBe(false);

    await expect(sendAdminAlertOnceEver(args)).resolves.toBe(true);
    await expect(sendAdminAlertOnceEver(args)).resolves.toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("never gives back a sibling's fresh claim under a different stamp, so the sibling's alert is not sent twice", async () => {
    fault = "sibling-claims-meanwhile";

    await expect(sendAdminAlertOnceEver(args)).resolves.toBe(false);
    expect(mocks.releaseAlertCooldown).toHaveBeenCalledWith({ key, claimedAt: stampPassedToClaim() });
    expect(held.get(key)?.getTime()).toBe(new Date(FROZEN_TEST_CLOCK_BASE_ISO).getTime() + 1);

    await expect(sendAdminAlertOnceEver(args)).resolves.toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("tries the give-back a second time when the first throws, and never throws itself", async () => {
    fault = "commits-then-throws";
    mocks.releaseAlertCooldown.mockRejectedValueOnce(new Error("Server has closed the connection."));

    await expect(sendAdminAlertOnceEver(args)).resolves.toBe(false);
    expect(mocks.releaseAlertCooldown).toHaveBeenCalledTimes(2);
    expect(held.has(key)).toBe(false);

    vi.clearAllMocks();
    fault = "commits-then-throws";
    mocks.releaseAlertCooldown.mockRejectedValue(new Error("still down"));
    await expect(sendAdminAlertOnceEver(args)).resolves.toBe(false);
    expect(mocks.releaseAlertCooldown).toHaveBeenCalledTimes(2);
  });
});

/**
 * #5255 (`INV-INT-042`): the claim is taken marked "no email yet", and what the
 * send's own email rows did - not only the counts it reports - decides whether
 * the claim is kept. A send that recorded no email under the claim gives it
 * back, so the next run sends; one that did is kept, and its row has already
 * confirmed it.
 */
describe("sendAdminAlertOnceEver reads what the alert's email rows did", () => {
  const key = "once:5255";
  const args = (send: () => Promise<typeof UNMUTEABLE_ALERT_SENT>) => ({ key, label: "test alert", context: { id: "5255" }, send });
  const QUEUED = { ...UNMUTEABLE_ALERT_SENT, sent: 0, queuedForRetry: 1 };
  const stamp = () => mocks.claimAlertCooldown.mock.calls[0][0].now;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.claimAlertCooldown.mockResolvedValue(true);
    mocks.confirmAlertCooldownSend.mockResolvedValue(true);
  });

  it("claims marked as having no email yet", async () => {
    await sendAdminAlertOnceEver(args(async () => UNMUTEABLE_ALERT_SENT));
    expect(mocks.claimAlertCooldown).toHaveBeenCalledWith(expect.objectContaining({ key, awaitingSend: true }));
  });

  it("keeps a claim its email row confirmed, with no second confirm", async () => {
    const kept = await sendAdminAlertOnceEver(
      args(async () => {
        const claim = takeOnceEverClaim()!;
        claim.rowWritten = true;
        return UNMUTEABLE_ALERT_SENT;
      }),
    );
    expect(kept).toBe(true);
    expect(mocks.confirmAlertCooldownSend).not.toHaveBeenCalled();
    expect(mocks.releaseAlertCooldown).not.toHaveBeenCalled();
  });

  it("gives back a claim whose every email row was refused, though the send counts them queued for retry", async () => {
    const kept = await sendAdminAlertOnceEver(
      args(async () => {
        takeOnceEverClaim()!.rowWriteFailed = true;
        return QUEUED;
      }),
    );
    expect(kept).toBe(false);
    expect(mocks.releaseAlertCooldown).toHaveBeenCalledWith({ key, claimedAt: stamp() });
    expect(mocks.deferAlertCooldown).not.toHaveBeenCalled();
  });

  it("gives back a claim whose sender took it and recorded no email, whatever it reports", async () => {
    const kept = await sendAdminAlertOnceEver(
      args(async () => {
        takeOnceEverClaim();
        return UNMUTEABLE_ALERT_SENT;
      }),
    );
    expect(kept).toBe(false);
    expect(mocks.releaseAlertCooldown).toHaveBeenCalledWith({ key, claimedAt: stamp() });
  });

  it("keeps a claim when one recipient's row was written and another's refused", async () => {
    const kept = await sendAdminAlertOnceEver(
      args(async () => {
        const claim = takeOnceEverClaim()!;
        claim.rowWritten = true;
        claim.rowWriteFailed = true;
        return UNMUTEABLE_ALERT_SENT;
      }),
    );
    expect(kept).toBe(true);
    expect(mocks.releaseAlertCooldown).not.toHaveBeenCalled();
  });

  it("still defers a claim nobody could receive, with no email row", async () => {
    const nobody = { ...UNMUTEABLE_ALERT_SENT, recipients: 0, sent: 0 };
    const kept = await sendAdminAlertOnceEver(
      args(async () => {
        takeOnceEverClaim();
        return nobody;
      }),
    );
    expect(kept).toBe(false);
    expect(mocks.deferAlertCooldown).toHaveBeenCalledTimes(1);
    expect(mocks.releaseAlertCooldown).not.toHaveBeenCalled();
  });

  it("confirms a kept claim itself when the sender never took it, trying twice and never throwing", async () => {
    await expect(sendAdminAlertOnceEver(args(async () => UNMUTEABLE_ALERT_SENT))).resolves.toBe(true);
    expect(mocks.confirmAlertCooldownSend).toHaveBeenCalledWith({ key, claimedAt: stamp() });

    vi.clearAllMocks();
    mocks.confirmAlertCooldownSend.mockRejectedValue(new Error("connection lost"));
    await expect(sendAdminAlertOnceEver(args(async () => UNMUTEABLE_ALERT_SENT))).resolves.toBe(true);
    expect(mocks.confirmAlertCooldownSend).toHaveBeenCalledTimes(2);
  });

  it("gives the claim to the send's first taker only, and to nothing outside the send", async () => {
    let second: unknown = "unset";
    await sendAdminAlertOnceEver(
      args(async () => {
        takeOnceEverClaim()!.rowWritten = true;
        second = takeOnceEverClaim();
        return UNMUTEABLE_ALERT_SENT;
      }),
    );
    expect(second).toBeNull();
    expect(takeOnceEverClaim()).toBeNull();
  });
});

/**
 * #5407 review: when every copy failed before its EmailLog row existed,
 * `sendToAdmins` now reports the alert undelivered rather than queued for the
 * retry cron, which has nothing to replay. The once-ever claim is then held a
 * day and the next run tries again, where it used to be kept and the alert
 * lost.
 */
describe("sendAdminAlertOnceEver when every copy failed before its row (#5407)", () => {
  const EVERY_COPY_LOST_BEFORE_ITS_ROW = {
    deliveryAllowed: true,
    recipients: 2,
    sent: 0,
    queuedForRetry: 0,
    notDelivered: 2,
    failedBeforeLogged: 2,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.claimAlertCooldown.mockResolvedValue(true);
  });

  it("holds the claim a day rather than keeping it for good", async () => {
    const send = vi.fn(async () => EVERY_COPY_LOST_BEFORE_ITS_ROW);

    // Not kept for good: deferred, so the claim is back a day later.
    await expect(sendAdminAlertOnceEver({ key: "once:5407", label: "test alert", context: {}, send })).resolves.toBe(false);

    expect(mocks.deferAlertCooldown).toHaveBeenCalledWith(
      expect.objectContaining({ key: "once:5407", retryAfterMs: 86_400_000 }),
    );
    expect(mocks.releaseAlertCooldown).not.toHaveBeenCalled();
  });
});
