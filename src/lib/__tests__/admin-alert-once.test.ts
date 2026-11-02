import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  claimAlertCooldown: vi.fn<(args: { key: string; windowMs: number; now: Date }) => Promise<boolean>>(),
  releaseAlertCooldown: vi.fn<(args: { key: string; claimedAt: Date }) => Promise<void>>(async () => {}),
  deferAlertCooldown: vi.fn(async () => {}),
}));

vi.mock("@/lib/alert-cooldown", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/lib/alert-cooldown")),
  claimAlertCooldown: mocks.claimAlertCooldown,
  releaseAlertCooldown: mocks.releaseAlertCooldown,
  deferAlertCooldown: mocks.deferAlertCooldown,
}));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/logger", () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { sendAdminAlertOnceEver, sendAdminAlertOnceEverClaim } from "@/lib/admin-alert-once";
import { UNMUTEABLE_ALERT_SENT } from "@/lib/email/admin-alert-send-result";

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
