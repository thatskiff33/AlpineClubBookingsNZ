/**
 * #4299 (`INV-PAY-148`): cash that races queued waivers of ONE extra invoice,
 * waived by several plans, is refunded exactly as if it had arrived before the
 * oldest plan - in every order of plans, cash imports (part and full) and
 * waiver runs, at every tier pairing, fixed fee or none.
 *
 * The plans are sized by the real arithmetic their callers use: a reduction's
 * basis is what its unpaid-extra offset leaves, capped at the cash still
 * refundable (`readOrganiserExtraReduction`, `effectiveOrganiserPaidChangeFeeCents`);
 * a cancel's is `cancelRefundableBaseCents` over the reduced price. Netting,
 * the state read and the raced-cash reservation are the real modules, over an
 * in-memory store. `policyRefundCents` below is the independent reference.
 */
import { describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";

type Row = { id: string; status: string; correlationKey: string; requestPayload: Record<string, unknown> };
const store = vi.hoisted(() => ({
  rows: [] as Row[],
  tasks: [] as { occurrenceKey: string; amountCents: number }[],
  priceCents: 0, feeCents: 0, cashCents: 0,
}));

/** The booking's adjustment rows and hand-backs; its one extra invoice and its imported cash. */
const db = vi.hoisted(() => {
  const matches = (row: Row, where: { status?: string; correlationKey?: string; requestPayload?: { path: string[]; equals: unknown } }) =>
    (where.status === undefined || row.status === where.status) &&
    (where.correlationKey === undefined || row.correlationKey === where.correlationKey) &&
    (where.requestPayload === undefined || row.requestPayload[where.requestPayload.path[0]!] === where.requestPayload.equals);
  const client = {
    $executeRaw: async () => 0,
    xeroSyncOperation: {
      findMany: async ({ where }: { where: { queueType?: string; status?: string } }) =>
        where.queueType === "ORGANISER_EXTRA_ADJUSTMENT" ? store.rows.filter((row) => matches(row, where)) : [],
      findFirst: async ({ where }: { where: Parameters<typeof matches>[1] }) => store.rows.find((row) => matches(row, where)) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: { requestPayload: Record<string, unknown> } }) => {
        store.rows.find((row) => row.id === where.id)!.requestPayload = data.requestPayload;
      },
      updateMany: async () => ({ count: 0 }),
      count: async () => 0,
    },
    bookingModification: {
      findMany: async () => [{ id: "increase", priceDiffCents: store.priceCents, changeFeeCents: store.feeCents }],
      findUniqueOrThrow: async () => ({ priceDiffCents: store.priceCents, changeFeeCents: store.feeCents }),
    },
    xeroObjectLink: {
      findMany: async () => [{ localId: "increase", xeroObjectId: "extra", metadata: { priceDiffCents: store.priceCents, changeFeeCents: store.feeCents } }],
    },
    paymentTransaction: { findMany: async () => (store.cashCents > 0 ? [{ xeroInvoiceId: "extra", amountCents: store.cashCents }] : []) },
    payment: { findUniqueOrThrow: async () => ({ id: "payment" }) },
    booking: { findUniqueOrThrow: async () => ({ id: "child", payment: { id: "payment" } }) },
    manualRefundTask: {
      findUnique: async ({ where }: { where: { occurrenceKey: string } }) => store.tasks.find((task) => task.occurrenceKey === where.occurrenceKey) ?? null,
      create: async ({ data }: { data: { occurrenceKey: string; amountCents: number } }) => {
        store.tasks.push({ occurrenceKey: data.occurrenceKey, amountCents: data.amountCents });
        return { id: `task-${store.tasks.length}` };
      },
    },
  };
  return { ...client, $transaction: async (run: (tx: typeof client) => Promise<unknown>) => run(client) };
});
vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("@/lib/organiser-billing", () => ({ resolveOrganiserBilling: async () => ({ combinedInvoiceId: "combined" }) }));
vi.mock("@/lib/xero-sync", () => ({
  startXeroSyncOperation: async (input: { status: string; correlationKey: string; requestPayload: Record<string, unknown> }) => {
    store.rows.push({ id: `row-${store.rows.length}`, status: input.status, correlationKey: input.correlationKey, requestPayload: { ...input.requestPayload } });
  },
}));

import { readOrganiserExtraReduction, readOrganiserExtraState, effectiveOrganiserPaidChangeFeeCents } from "@/lib/organiser-extra-state";
import { reserveOrganiserExtraCancellation, settleOrganiserExtraReduction } from "@/lib/organiser-extra-netting";
import { reserveOrganiserExtraRacedCash } from "@/lib/organiser-extra-raced-cash";
import { cancelRefundableBaseCents } from "@/lib/booking-payment-state";
import { calculateRefundAmount } from "@/lib/policies/cancellation";
import { readOrganiserExtraAdjustmentPayload } from "@/lib/organiser-extra-adjustment-payload";

type Tier = { percentage: number; fixedFeeCents: number };
type PlanSpec = { id: string; kind: "reduction"; reductionCents: number; tier: Tier } | { id: string; kind: "cancel"; tier: Tier };
type Scenario = { shareCents: number; priceCents: number; feeCents: number; partialCents: number; plans: PlanSpec[] };

const tierRefund = (basisCents: number, tier: Tier) =>
  calculateRefundAmount(basisCents, 0, [{ daysBeforeStay: 0, refundPercentage: tier.percentage, creditRefundPercentage: tier.percentage, fixedFeeCents: tier.fixedFeeCents, creditFixedFeeCents: 0 }], "card").refundAmountCents;

/**
 * THE REFERENCE, independent of the code under test: every cent the organiser
 * paid on the extra arrived before the oldest plan. Cash pays the fee first;
 * each reduction is set against what is still unpaid, the rest refunded at
 * its tier from the cash still refundable; the cancel refunds what was paid,
 * no more than the booking is now worth, less the fee paid.
 */
function policyRefundCents(scenario: Scenario, cashCents: number): number {
  const { shareCents, priceCents, feeCents } = scenario;
  const feePaidCents = Math.min(feeCents, cashCents);
  let unpaidCents = priceCents + feeCents - cashCents;
  let priceNowCents = shareCents + priceCents;
  let refundedCents = 0;
  for (const plan of scenario.plans) {
    if (plan.kind === "reduction") {
      const offsetCents = Math.min(plan.reductionCents, unpaidCents);
      unpaidCents -= offsetCents;
      const basisCents = Math.max(0, Math.min(plan.reductionCents - offsetCents, shareCents + cashCents - feePaidCents - refundedCents));
      refundedCents += Math.max(0, Math.round((basisCents * plan.tier.percentage) / 100) - plan.tier.fixedFeeCents);
      priceNowCents -= plan.reductionCents;
    } else {
      const baseCents = Math.min(shareCents + cashCents - refundedCents, priceNowCents + feePaidCents) - feePaidCents;
      refundedCents += Math.max(0, Math.round((baseCents * plan.tier.percentage) / 100) - plan.tier.fixedFeeCents);
    }
  }
  return refundedCents;
}

type Event = `plan:${string}` | `run:${string}` | "pay-part" | "pay-rest";

/** Plays one order of events through the real modules; returns what was refunded and the store. */
async function play(scenario: Scenario, order: readonly Event[]) {
  store.rows = []; store.tasks = []; store.cashCents = 0;
  store.priceCents = scenario.priceCents; store.feeCents = scenario.feeCents;
  const tx = db as unknown as Prisma.TransactionClient;
  let creditedCents = 0;
  let priceNowCents = scenario.shareCents + scenario.priceCents;
  let editHandBackCents = 0; // a reduction's own refund: an open edit hand-back (`openNonCancellationHandBackCents`)
  const planRefunds: { basisCents: number; refundCents: number }[] = [];
  const ran = new Set<string>();
  const dueCents = () => scenario.priceCents + scenario.feeCents - store.cashCents - creditedCents;
  const waiverOf = (planId: string) => store.rows.map((row) => readOrganiserExtraAdjustmentPayload(row.requestPayload)!).find((row) => row.purpose === "waive" && row.scopeId === planId);
  const runWaiver = async (planId: string) => {
    const waiver = waiverOf(planId);
    if (!waiver) return;
    // The executor reserves raced cash, credits what is still due on a first run, and reserves again.
    await reserveOrganiserExtraRacedCash("child", { modificationId: "increase", invoiceId: "extra", cashCents: store.cashCents });
    if (!ran.has(planId) && dueCents() > 0) creditedCents += Math.min(waiver.amountCents, dueCents());
    ran.add(planId);
    await reserveOrganiserExtraRacedCash("child", { modificationId: "increase", invoiceId: "extra", cashCents: store.cashCents });
  };
  for (const event of order) {
    if (event === "pay-part") store.cashCents += Math.min(scenario.partialCents, dueCents());
    else if (event === "pay-rest") store.cashCents += dueCents();
    else if (event.startsWith("run:")) await runWaiver(event.slice(4));
    else {
      const plan = scenario.plans.find((p) => p.id === event.slice(5))!;
      const state = await readOrganiserExtraState(tx, "child");
      const feePaidCents = effectiveOrganiserPaidChangeFeeCents(scenario.feeCents, state);
      const paidCents = scenario.shareCents + store.cashCents;
      if (plan.kind === "reduction") {
        const reduction = await readOrganiserExtraReduction(tx, "child", plan.reductionCents);
        const basisCents = Math.max(0, Math.min(plan.reductionCents - reduction.offsetCents, paidCents - editHandBackCents - feePaidCents));
        const refundCents = tierRefund(basisCents, plan.tier);
        await settleOrganiserExtraReduction(tx, { reduction: { ...reduction, scopeId: plan.id }, refundAmountCents: refundCents, refundBasisCents: basisCents, refundPercentage: plan.tier.percentage, fixedFeeCents: plan.tier.fixedFeeCents });
        planRefunds.push({ basisCents, refundCents });
        editHandBackCents += refundCents;
        priceNowCents -= plan.reductionCents;
      } else {
        const basisCents = cancelRefundableBaseCents({ amountCents: paidCents, refundedAmountCents: 0, openNonCancellationHandBackCents: editHandBackCents, finalPriceCents: priceNowCents, changeFeeCents: feePaidCents });
        const refundCents = tierRefund(basisCents, plan.tier);
        await reserveOrganiserExtraCancellation(tx, { bookingId: "child", scopeId: plan.id, refundAmountCents: refundCents, refundBasisCents: basisCents, refundPercentage: plan.tier.percentage, fixedFeeCents: plan.tier.fixedFeeCents });
        planRefunds.push({ basisCents, refundCents });
      }
    }
  }
  const settled = { rows: store.rows.length, tasks: store.tasks.length };
  for (const plan of scenario.plans) await runWaiver(plan.id); // replay every waiver
  const payloads = store.rows.map((row) => readOrganiserExtraAdjustmentPayload(row.requestPayload)!);
  return {
    refundedCents: planRefunds.reduce((sum, plan) => sum + plan.refundCents, 0) + store.tasks.reduce((sum, task) => sum + task.amountCents, 0),
    planBasisCents: planRefunds.reduce((sum, plan) => sum + plan.basisCents, 0),
    racedBasisCents: payloads.filter((row) => row.racedPlanScopeId).reduce((sum, row) => sum + (row.priceBasisCents ?? 0), 0),
    waivedCents: payloads.filter((row) => row.purpose === "waive").reduce((sum, row) => sum + row.amountCents, 0),
    replayAdded: store.rows.length - settled.rows + store.tasks.length - settled.tasks,
  };
}

/** Every order of `events` in which each event follows those it `needs`. */
function orders(events: readonly Event[], needs: Partial<Record<Event, Event[]>>): Event[][] {
  if (events.length === 0) return [[]];
  return events.flatMap((event, index) => {
    const rest = events.filter((_, at) => at !== index);
    if ((needs[event] ?? []).some((need) => rest.includes(need))) return [];
    return orders(rest, needs).map((tail) => [event, ...tail]);
  });
}

const TIERS: Record<string, Tier[]> = {
  "reduction's tier above the cancel's": [{ percentage: 50, fixedFeeCents: 0 }, { percentage: 25, fixedFeeCents: 0 }, { percentage: 25, fixedFeeCents: 0 }],
  "reduction's tier below the cancel's": [{ percentage: 25, fixedFeeCents: 0 }, { percentage: 50, fixedFeeCents: 0 }, { percentage: 75, fixedFeeCents: 0 }],
  "equal tiers": [{ percentage: 50, fixedFeeCents: 0 }, { percentage: 50, fixedFeeCents: 0 }, { percentage: 50, fixedFeeCents: 0 }],
  "fixed fees larger than a refund": [{ percentage: 25, fixedFeeCents: 5_000 }, { percentage: 50, fixedFeeCents: 300 }, { percentage: 25, fixedFeeCents: 2_000 }],
  "small fixed fees, 100% and 0%": [{ percentage: 100, fixedFeeCents: 700 }, { percentage: 0, fixedFeeCents: 0 }, { percentage: 100, fixedFeeCents: 0 }],
};
const SHAPES: Record<string, (tiers: Tier[]) => PlanSpec[]> = {
  "a $30 reduction, then a cancel": ([r, c]) => [{ id: "reduction", kind: "reduction", reductionCents: 3_000, tier: r! }, { id: "cancel", kind: "cancel", tier: c! }],
  "two reductions, then a cancel": ([r1, r2, c]) => [
    { id: "first-cut", kind: "reduction", reductionCents: 2_000, tier: r1! }, { id: "second-cut", kind: "reduction", reductionCents: 4_500, tier: r2! }, { id: "cancel", kind: "cancel", tier: c! },
  ],
  "two reductions, no cancel": ([r1, r2]) => [{ id: "first-cut", kind: "reduction", reductionCents: 3_000, tier: r1! }, { id: "second-cut", kind: "reduction", reductionCents: 3_500, tier: r2! }],
  "a reduction past the extra's price, then a cancel": ([r, c]) => [{ id: "reduction", kind: "reduction", reductionCents: 6_000, tier: r! }, { id: "cancel", kind: "cancel", tier: c! }],
  "a cancel alone": ([, c]) => [{ id: "cancel", kind: "cancel", tier: c! }],
};

describe("raced cash on one extra invoice waived by several plans: exact in every interleaving", () => {
  for (const [shapeName, shape] of Object.entries(SHAPES)) {
    it(`${shapeName}: matches the cash-first policy, refunds cash once, never the fee, and a replay adds nothing`, async () => {
      let cases = 0;
      for (const [tierName, tiers] of Object.entries(TIERS)) {
        const plans = shape(tiers);
        for (const feeCents of [1_000, 0]) for (const partialCents of [3_000, 500]) for (const payments of [["pay-part", "pay-rest"], ["pay-rest"], ["pay-part"]] as Event[][]) {
          const scenario: Scenario = { shareCents: 10_000, priceCents: 5_000, feeCents, partialCents, plans };
          const needs: Partial<Record<Event, Event[]>> = { "pay-rest": payments.includes("pay-part") ? ["pay-part"] : [] };
          plans.forEach((plan, index) => {
            needs[`run:${plan.id}`] = [`plan:${plan.id}`];
            if (index > 0) needs[`plan:${plan.id}`] = [`plan:${plans[index - 1]!.id}`];
          });
          const events: Event[] = [...plans.flatMap((plan) => [`plan:${plan.id}`, `run:${plan.id}`] as Event[]), ...payments];
          for (const order of orders(events, needs)) {
            const result = await play(scenario, order);
            const label = `${tierName}, fee ${feeCents}, part ${partialCents}: ${order.join(" > ")}`;
            const cashCents = store.cashCents;
            // 1. Exactly what the policy refunds had the cash arrived before the oldest plan.
            expect(result.refundedCents, label).toBe(policyRefundCents(scenario, cashCents));
            // 2. Cash is refunded once: raced price never exceeds the waived debt the cash covered.
            expect(result.racedBasisCents, label).toBeLessThanOrEqual(Math.max(0, result.waivedCents + cashCents - (scenario.priceCents + scenario.feeCents)));
            // 3. The fee is never refunded: every basis together stays within the money paid, less the fee paid.
            expect(result.planBasisCents + result.racedBasisCents, label).toBeLessThanOrEqual(scenario.shareCents + cashCents - Math.min(feeCents, cashCents));
            // 4. A replay of every waiver reserves nothing.
            expect(result.replayAdded, label).toBe(0);
            cases += 1;
          }
        }
      }
      expect(cases).toBeGreaterThan(100);
    }, 120_000);
  }
});
