import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { functionCalls, manualRefundTaskCreationSites } from "./support/manual-refund-task-creation-scan";
import { productionSourceFiles } from "./support/prisma-delegate-read-scan";

/**
 * THE TASK-CREATION-SITE CENSUS (#5185, Ledger M4d). Every place production code creates a `ManualRefundTask` row
 * is classified here, keyed `file|function|method|n` (n: how many such calls the function makes), so a new raise
 * site fails until someone decides what the member-money journal records for it:
 *
 * - `posts R05`: a bank or cash hand-back (`isJournalHandBackTask`). Its own enclosing function must call
 *   `postHandBackObligation`, the R05 beside the task, under the same locks; the hand-back census lists a task
 *   raised without it (`HAND_BACK_WITHOUT_EVENT`).
 * - `recorded by another step`: the journal records the money when that step runs, named here (and, where it is
 *   the same function, called by it).
 * - `not a debt`: the task records no member-money refund debt, or one a later milestone owns.
 *
 * Re-counted on main after #4998 merged (#5185): sixteen sites under `src/`, as #4516's plan counted, though one
 * of them is new since (`card-refund-group-paid-another-way.ts`, #4851) and is not a debt; plus the demo seed.
 */
type Entry =
  | { class: "posts R05"; reason: string }
  | { class: "recorded by another step"; reason: string; calls?: string }
  | { class: "not a debt"; reason: string };

const SITES: Record<string, Entry> = {
  "src/lib/booking-cancel.ts|performBookingCancellation|create|1": { class: "posts R05", reason: "a cash or bank cancellation's hand-back" },
  "src/lib/cancel-card-refund-shortfall.ts|raiseCardShortfallPart|createMany|1": { class: "posts R05", reason: "a card refund shortfall's bank part or part to check" },
  "src/lib/edit-refund-hand-back.ts|raiseEditRefundHandBackIfOwed|createMany|1": { class: "posts R05", reason: "an edit's refund paid back by hand" },
  "src/lib/edit-refund-hand-back.ts|raiseRefundRequestHandBack|createMany|1": { class: "posts R05", reason: "an approved refund request's bank part, its concession against goodwill" },
  "src/lib/xero-inbound/invoice-paid-effects.ts|runAlreadyCancelledCreditMintArm|create|1": { class: "posts R05", reason: "an organisation's late cash on a booking already cancelled" },
  "src/lib/card-refund-paid-another-way.ts|closeCardRefundPaidAnotherWay|create|1": {
    class: "recorded by another step", calls: "closePaidAnotherWayRest",
    reason: "a card refund closed as paid another way: the close record's R14 and any kept rest's close-out (M4c)",
  },
  "src/lib/late-capture-refund-hold.ts|holdLateCaptureForTreasurerIfRequired|create|1": {
    class: "recorded by another step",
    reason: "a late capture held for the treasurer: approving it posts the capture-return R05, keeping it posts the keep (kept-capture)",
  },
  "src/lib/card-refund-group-paid-another-way.ts|closePerJoiner|create|1": { class: "not a debt", reason: "an organiser child's card refund closed by bank: organiser shares are M6's, so no R14" },
  "src/lib/edit-financial-review.ts|raiseEditFinancialReviewTask|create|1": { class: "not a debt", reason: "an edit financial review: its closure posts R21, or R05 scope review when closed by hand" },
  "src/lib/internet-banking-part-payment-at-cancel.ts|raisePartPaymentReviewTask|create|1": { class: "not a debt", reason: "a part-payment review records money settled in Xero, never an amount owed back" },
  "src/lib/deleted-booking-modification-payment.ts|raiseDeletedBookingModificationRefundTask|create|1": { class: "not a debt", reason: "#2700's change payment captured on a deleted booking: a late capture's own question" },
  "src/lib/deleted-booking-modification-payment.ts|recordAutomaticCancelledBookingRefundTask|create|1": { class: "not a debt", reason: "an automatic late capture's record: its refund defers its R05 to the sender (M4c)" },
  "src/lib/organiser-extra-raced-cash.ts|reserveOrganiserExtraRacedCash|create|1": { class: "not a debt", reason: "organiser-extra raced cash is an organiser share (M6)" },
  "src/lib/group-organiser-hand-back.ts|recordGroupOrganiserHandBackShare|create|2": { class: "not a debt", reason: "a group organiser's hand-back share (M6)" },
  "src/lib/bank-refund-void-follow-up.ts|undoUnderLocks|createMany|1": { class: "not a debt", reason: "a voided bank refund note's follow-up (M10, decision D2)" },
  "prisma/demo-seed.ts|main|create|1": { class: "not a debt", reason: "synthetic demo seed only; no journal is posted for demo data" },
};

/** Every creation site in production code, counted per function, with its enclosing function. */
function census() {
  const counts = new Map<string, { n: number; enclosing: ts.Node | null }>();
  for (const file of productionSourceFiles(process.cwd())) {
    for (const site of manualRefundTaskCreationSites(file, readFileSync(file, "utf8"))) {
      const seen = counts.get(site.key);
      counts.set(site.key, { n: (seen?.n ?? 0) + 1, enclosing: site.enclosing });
    }
  }
  return new Map([...counts].map(([key, { n, enclosing }]) => [`${key}|${n}`, enclosing]));
}

describe("#5185 task-creation-site census: every ManualRefundTask raise is classified for the member-money journal", () => {
  it("classifies every creation site, with no stale entry and no raw insert", () => {
    const found = census();
    expect([...found.keys()].sort()).toEqual(Object.keys(SITES).sort());
    expect([...found.keys()].filter((key) => key.includes("|raw-sql|"))).toEqual([]);
    // Sixteen calls under src/ (#5185's re-count): each key's last part is how many its function makes.
    expect(Object.keys(SITES).filter((key) => key.startsWith("src/")).reduce((sum, key) => sum + Number(key.split("|").at(-1)), 0)).toBe(16);
    for (const entry of Object.values(SITES)) expect(entry.reason.length).toBeGreaterThan(20);
  }, 15_000);

  it("a site that posts R05 calls postHandBackObligation in its own function; another step's site calls the step it names", () => {
    const found = census();
    for (const [key, entry] of Object.entries(SITES)) {
      const callee = entry.class === "posts R05" ? "postHandBackObligation" : entry.class === "recorded by another step" ? entry.calls : undefined;
      if (!callee) continue;
      const enclosing = found.get(key);
      expect(enclosing, key).toBeTruthy();
      expect(functionCalls(enclosing!, callee), `${key} must call ${callee}`).toBe(true);
    }
  }, 15_000);

  it("finds a direct, bracket, constant-keyed, aliased, destructured, nested and raw creation, and no read", () => {
    for (const write of [
      "tx.manualRefundTask.create({ data })",
      "tx.manualRefundTask.createMany({ data, skipDuplicates: true })",
      'tx["manualRefundTask"].create({ data })',
      'const model = "manualRefundTask"; tx[model].upsert({ where, create, update })',
      "const tasks = tx.manualRefundTask; tasks.create({ data })",
      "const { manualRefundTask: tasks } = tx; tasks.createMany({ data })",
      "tx.booking.update({ where, data: { manualRefundTasks: { create: { reason } } } })",
      'tx.$executeRaw`INSERT INTO "ManualRefundTask" ("id") VALUES (${id})`',
    ]) expect(manualRefundTaskCreationSites("new.ts", write), write).toHaveLength(1);
    expect(manualRefundTaskCreationSites("new.ts", "tx.manualRefundTask.findMany({ where: { status: \"OPEN\" } })")).toEqual([]);
    expect(manualRefundTaskCreationSites("new.ts", "tx.manualRefundTask.updateMany({ where, data })")).toEqual([]);
  });

  it("names the function a site is in, and whether that function calls the poster", () => {
    const [site] = manualRefundTaskCreationSites("new.ts", "async function raiseIt(tx) { const task = await tx.manualRefundTask.create({ data }); await postHandBackObligation(tx, journal, task); }");
    expect(site!.key).toBe("new.ts|raiseIt|create");
    expect(functionCalls(site!.enclosing!, "postHandBackObligation")).toBe(true);
    const [skipped] = manualRefundTaskCreationSites("new.ts", "const raiseIt = async (tx) => { await tx.manualRefundTask.create({ data }); };");
    expect(skipped!.key).toBe("new.ts|raiseIt|create");
    expect(functionCalls(skipped!.enclosing!, "postHandBackObligation")).toBe(false);
  });
});
