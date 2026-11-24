import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AlertCooldownFake } from "./helpers/alert-cooldown-fake";

const db = vi.hoisted(() => ({ fake: null as unknown as AlertCooldownFake }));

vi.mock("@/lib/prisma", async () => {
  const { createAlertCooldownFake } = await import("./helpers/alert-cooldown-fake");
  db.fake = createAlertCooldownFake();
  return { prisma: { alertCooldown: db.fake.delegate } };
});
vi.mock("@/lib/logger", () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { sendAdminAlertOnceEver } from "@/lib/admin-alert-once";
import { sweepOnceEverAlerts } from "@/lib/admin-alert-once-sweep";
import { UNMUTEABLE_ALERT_SENT } from "@/lib/email/admin-alert-send-result";

/**
 * #5255: the two ways a once-ever alert was lost for good after #4696. The
 * claim write throws, so nothing is sent and the helper gives the stamp back;
 * the note still ends up held when (A) the write had committed and both
 * give-backs fail, or (B) the write commits only after the give-back ran. The
 * sweep finds such a note, held with no email behind it, and gives it back, so
 * the next run sends - exactly once.
 */
describe("#5255: a once-ever note held with nothing sent is given back by the sweep", () => {
  const key = "once:5255";
  const send = vi.fn(async () => UNMUTEABLE_ALERT_SENT);
  const run = () => sendAdminAlertOnceEver({ key, label: "test alert", context: { key }, send });
  const minutesFromNow = (minutes: number) => new Date(Date.now() + minutes * 60_000);
  const connectionDropped = () => new Error("Server has closed the connection.");

  beforeEach(() => {
    vi.clearAllMocks();
    db.fake.reset();
  });

  async function expectSweepRecovers() {
    expect(db.fake.rows.has(key), "the lost note is held").toBe(true);
    await expect(run(), "held: the next run alone cannot send").resolves.toBe(false);
    await sweepOnceEverAlerts(minutesFromNow(5));
    await expect(run(), "inside the grace the sweep leaves it").resolves.toBe(false);
    expect(send).not.toHaveBeenCalled();

    await sweepOnceEverAlerts(minutesFromNow(16));
    await expect(run()).resolves.toBe(true);
    expect(send).toHaveBeenCalledTimes(1);

    await sweepOnceEverAlerts(minutesFromNow(60));
    await expect(run(), "a sent alert is never given back").resolves.toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
  }

  it("A: the claim commits and throws, and both give-backs fail on the same outage", async () => {
    db.fake.intercept("create", async (write) => {
      await write();
      throw connectionDropped();
    });
    db.fake.intercept("deleteMany", async () => {
      throw connectionDropped();
    });
    db.fake.intercept("deleteMany", async () => {
      throw connectionDropped();
    });

    await expect(run()).resolves.toBe(false);
    expect(send).not.toHaveBeenCalled();
    await expectSweepRecovers();
  });

  it("B: the claim commits only after the give-back ran", async () => {
    let commitLate: () => Promise<unknown> = async () => undefined;
    db.fake.intercept("create", async (write) => {
      commitLate = write;
      throw connectionDropped();
    });

    await expect(run()).resolves.toBe(false);
    expect(db.fake.rows.has(key), "the give-back found nothing to delete").toBe(false);
    await commitLate();
    expect(send).not.toHaveBeenCalled();
    await expectSweepRecovers();
  });
});
