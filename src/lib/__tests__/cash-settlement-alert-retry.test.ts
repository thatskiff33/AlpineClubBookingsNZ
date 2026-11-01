import { beforeEach, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { matchesWhere } from "./support/prisma-where";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";
import { IB_SETTLEMENT_FIGURE_CHECK_EVENT_KIND, type IbSettlementFigureCheckEventSnapshot } from "@/lib/manual-settlement-reversal-event";

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn(), count: vi.fn(),
  cooldownUpdate: vi.fn(), cooldownCreate: vi.fn(), send: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: {
  bookingEvent: { findMany: mocks.findMany, findUnique: mocks.findUnique, update: mocks.update, updateMany: mocks.updateMany, count: mocks.count },
  alertCooldown: { updateMany: mocks.cooldownUpdate, create: mocks.cooldownCreate },
} }));
vi.mock("@/lib/email", () => ({ sendAdminBankTransferSettlementFigureAlert: mocks.send }));
vi.mock("@/lib/logger", () => ({ default: { warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/club-format-server", () => ({ clubFormatValues: async () => CLUB_FORMAT_TEST }));
vi.mock("@/lib/xero-hardening", () => ({}));
vi.mock("@/lib/xero-operation-outbox", () => ({}));
vi.mock("@/lib/xero-operation-queue", () => ({}));
vi.mock("@/lib/xero-inbound-reconciliation", () => ({}));
vi.mock("@/lib/xero-membership-sync", () => ({}));
// #4432: the inbound cycle now runs under a database run claim, proven against
// real PostgreSQL in `xero-inbound-run-claim.realdb.test.ts`; here it passes through.
vi.mock("@/lib/cron-run-claim", () => ({
  withCronRunClaim: vi.fn(async (_name: string, work: (assertOwned: () => Promise<void>) => Promise<unknown>) => ({ claimed: true, result: await work(async () => {}) })),
}));
import { raiseCashSettlementAlert } from "@/lib/xero-inbound/settle-from-cash-notice";
import { countExhaustedCashSettlementAlerts, retryCashSettlementAlerts } from "@/lib/xero-inbound/cash-settlement-alert-retry";
import { runXeroCronTaskList } from "@/lib/xero-cron-runner";

const booking = {
  checkIn: new Date("2026-07-10T00:00:00Z"), checkOut: new Date("2026-07-12T00:00:00Z"),
  member: { firstName: "Test", lastName: "Member" }, organisation: null,
};
let snapshot: IbSettlementFigureCheckEventSnapshot;
let cooldown: { key: string; lastAlertedAt: Date } | null;
const row = () => ({ id: "marker", bookingId: "booking", snapshot: { ...snapshot }, booking });
const delivery = () => raiseCashSettlementAlert({
  marker: { id: "marker", snapshot: { ...snapshot } }, payment: { id: "payment", bookingId: "booking", booking },
  memberName: "Test Member", invoiceId: "invoice", format: CLUB_FORMAT_TEST,
});
const cron = () => runXeroCronTaskList(["inbound"], {
  isModuleEnabled: async () => true, isConnected: async () => true, recordCronRun: vi.fn(),
  tasks: { runXeroInboundReconciliationCycle: vi.fn().mockResolvedValue({}) },
});

beforeEach(() => {
  vi.resetAllMocks();
  vi.setSystemTime(new Date("2026-07-01T00:00:00Z"));
  snapshot = {
    kind: IB_SETTLEMENT_FIGURE_CHECK_EVENT_KIND, invoiceId: "invoice", invoiceNumber: "INV-TEST",
    refusal: "folded-refund", recordedCents: 10000, cashCents: 12000, cashComplete: true,
    owedCents: null, hasSupplementaryInvoice: false, alertSentAt: null,
  };
  cooldown = null;
  mocks.findMany.mockImplementation(async () => [row()]);
  mocks.findUnique.mockImplementation(async () => ({ snapshot: { ...snapshot } }));
  mocks.update.mockImplementation(async ({ data }) => { snapshot = data.snapshot; return {}; });
  mocks.cooldownUpdate.mockImplementation(async ({ where, data }) => {
    if (!cooldown || !matchesWhere(cooldown, where)) return { count: 0 };
    cooldown = { ...cooldown, ...data };
    return { count: 1 };
  });
  mocks.cooldownCreate.mockImplementation(async ({ data }) => {
    if (cooldown) throw new Prisma.PrismaClientKnownRequestError("duplicate", { code: "P2002", clientVersion: "test" });
    cooldown = { ...data };
    return cooldown;
  });
  mocks.updateMany.mockImplementation(async ({ where, data }) => {
    if (JSON.stringify(where.snapshot.equals) !== JSON.stringify(snapshot)) return { count: 0 };
    snapshot = data.snapshot;
    return { count: 1 };
  });
  mocks.send.mockResolvedValue("sent");
});

it("the existing inbound cron retries a failed delivery without another invoice delivery", async () => {
  mocks.send.mockRejectedValueOnce(new Error("mail unavailable"));
  await delivery();
  expect(snapshot).toMatchObject({ alertSentAt: null, alertUndeliveredCount: 1 });
  vi.setSystemTime(new Date("2026-07-01T00:11:00Z"));
  await cron();
  expect(mocks.send).toHaveBeenCalledTimes(2);
  expect(snapshot.alertSentAt).toBe("2026-07-01T00:11:00.000Z");
  await cron();
  expect(mocks.send).toHaveBeenCalledTimes(2);
});

it("selects only unsent settlement markers older than the in-flight window", async () => {
  // Query-boundary contract: the database returns no rows for a recent marker.
  mocks.findMany.mockResolvedValue([]);
  await retryCashSettlementAlerts(CLUB_FORMAT_TEST);
  expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: {
    type: "CANCELLED",
    snapshot: { path: ["kind"], equals: IB_SETTLEMENT_FIGURE_CHECK_EVENT_KIND },
    AND: [{ snapshot: { path: ["alertSentAt"], equals: Prisma.JsonNull } }],
    createdAt: { lt: new Date("2026-06-30T23:50:00Z") },
  } }));
  expect(mocks.send).not.toHaveBeenCalled();
});

it("the real cooldown claim permits one send when a sweep races a delivery", async () => {
  await Promise.all([retryCashSettlementAlerts(CLUB_FORMAT_TEST), delivery()]);
  expect(mocks.send).toHaveBeenCalledTimes(1);
  expect(snapshot.alertSentAt).not.toBeNull();
});

it("stops both delivery and sweep retries at three failures and counts the durable escalation", async () => {
  mocks.send.mockRejectedValue(new Error("mail unavailable"));
  for (const time of ["00:00", "00:11", "00:22", "00:33"]) {
    vi.setSystemTime(new Date(`2026-07-01T${time}:00Z`));
    await cron();
  }
  await delivery();
  expect(mocks.send).toHaveBeenCalledTimes(3);
  expect(snapshot).toMatchObject({ alertSentAt: null, alertUndeliveredCount: 3 });
  mocks.count.mockResolvedValue(1);
  expect(await countExhaustedCashSettlementAlerts()).toBe(1);
  expect(mocks.count).toHaveBeenCalledWith({ where: expect.objectContaining({
    AND: [
      { snapshot: { path: ["alertSentAt"], equals: Prisma.JsonNull } },
      { snapshot: { path: ["alertUndeliveredCount"], gte: 3 } },
    ],
  }) });
});

it("re-reads after claiming, so a stale delivery cannot re-send a recorded alert", async () => {
  snapshot.alertSentAt = "2026-06-30T23:00:00Z";
  // Present the sender with a snapshot taken before the other sender finished.
  await raiseCashSettlementAlert({
    marker: { id: "marker", snapshot: { ...snapshot, alertSentAt: null } },
    payment: { bookingId: "booking", booking }, memberName: "Test Member", invoiceId: "invoice", format: CLUB_FORMAT_TEST,
  });
  expect(mocks.send).not.toHaveBeenCalled();
});


it("retries committed alerts while Xero is disconnected and records that work as SUCCESS", async () => {
  const recordCronRun = vi.fn();
  await runXeroCronTaskList(["inbound"], {
    isModuleEnabled: async () => true, isConnected: async () => false, recordCronRun,
  });
  expect(mocks.send).toHaveBeenCalledTimes(1);
  expect(snapshot.alertSentAt).not.toBeNull();
  expect(recordCronRun).toHaveBeenCalledWith(expect.objectContaining({
    jobName: "xero-inbound-reconcile", status: "SUCCESS",
  }));
});

it("retries a resolved but undelivered send instead of marking it sent", async () => {
  mocks.send.mockResolvedValueOnce("undelivered");
  await delivery();
  expect(snapshot).toMatchObject({ alertSentAt: null, alertUndeliveredCount: 1 });
  vi.setSystemTime(new Date("2026-07-01T00:11:00Z"));
  await cron();
  expect(snapshot.alertSentAt).not.toBeNull();
});

it("a failed sender that outlives its cooldown cannot erase a newer sent stamp", async () => {
  let failFirst!: (error: Error) => void;
  let started!: () => void;
  const sending = new Promise<void>((resolve) => { started = resolve; });
  mocks.send.mockImplementationOnce(() => {
    started();
    return new Promise((_, reject) => { failFirst = reject; });
  });
  const first = delivery();
  await sending;
  vi.setSystemTime(new Date("2026-07-01T00:11:00Z"));
  await cron();
  failFirst(new Error("late failure"));
  await first;
  expect(snapshot.alertSentAt).toBe("2026-07-01T00:11:00.000Z");
  expect(snapshot.alertUndeliveredCount).toBeUndefined();
});
