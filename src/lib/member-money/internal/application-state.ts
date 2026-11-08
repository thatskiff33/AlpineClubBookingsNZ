import { MemberMoneyAccount, MemberMoneySide } from "@prisma/client";
import { z } from "zod";
import { applicationRole } from "./plan";

const Source = z.object({
  id: z.string(), sourceKind: z.string(), account: z.enum(MemberMoneyAccount), side: z.enum(MemberMoneySide), amountCents: z.number().int(),
  debtorKind: z.string().nullable(), memberId: z.string().nullable(), organisationId: z.string().nullable(),
  currency: z.string(), bookingId: z.string().nullable(), obligationId: z.string().nullable(),
  capture: z.string().nullable(), reversed: z.boolean(),
});
const Obligation = z.object({
  id: z.string(), key: z.string(), kind: z.enum(["CHARGE", "REFUND"]), faceCents: z.number().int(),
  debtorKind: z.string(), memberId: z.string().nullable(), organisationId: z.string().nullable(), currency: z.string(),
});
const Application = z.object({
  id: z.string(), sourceLineId: z.string(), obligationId: z.string(), amountCents: z.number().int(),
  reversesApplicationId: z.string().nullable(),
});
const Reservation = z.object({
  id: z.string(), attemptKey: z.string(), obligationId: z.string(), capture: z.string(), amountCents: z.number().int(),
});
export const MemberMoneyApplicationState = z.object({
  sources: z.array(Source), obligations: z.array(Obligation), applications: z.array(Application), reservations: z.array(Reservation),
});
export type ApplicationState = z.infer<typeof MemberMoneyApplicationState>;
export type ApplicationSource = z.infer<typeof Source>;
export type ApplicationObligation = z.infer<typeof Obligation>;

export function refundFamilyKey(key: string): string { return key.split("|for|")[0]!; }
export function applicationRoleOf(source: ApplicationSource, obligation: ApplicationObligation): "collect" | "fund" | "pay" | null {
  const role = applicationRole(source, obligation.kind);
  return role === "pay" && source.obligationId !== obligation.id ? null : role;
}
export function sameApplicationDebtor(source: ApplicationSource, obligation: ApplicationObligation): boolean {
  return source.currency === obligation.currency && source.debtorKind === obligation.debtorKind
    && source.memberId === obligation.memberId && source.organisationId === obligation.organisationId;
}

export interface ApplicationTotals {
  sources: Map<string, number>;
  /** Net applied to each obligation, by its id: what a successor carries forward from its predecessor. */
  obligations: Map<string, number>;
  collected: number;
  families: Map<string, { funded: number; paid: number; reserved: number; captures: Map<string, { funded: number; paid: number; reserved: number }> }>;
}

/** One conservation rule for store projections and the population-wide verifier. C2 is deliberately separate. */
export function memberMoneyApplicationTotals(state: ApplicationState): ApplicationTotals {
  const sources = new Map(state.sources.map((s) => [s.id, s]));
  const obligations = new Map(state.obligations.map((o) => [o.id, o]));
  const applications = new Map(state.applications.map((a) => [a.id, a]));
  const totals: ApplicationTotals = { sources: new Map(), obligations: new Map(), collected: 0, families: new Map() };
  const sign = (id: string, visited = new Set<string>()): number => {
    if (visited.has(id)) throw new Error("Cyclic member-money application reversal");
    visited.add(id);
    const application = applications.get(id);
    if (!application) throw new Error(`Missing original member-money application ${id}`);
    return application.reversesApplicationId === null ? 1 : -sign(application.reversesApplicationId, visited);
  };
  const family = (obligation: ApplicationObligation) => {
    const key = refundFamilyKey(obligation.key);
    let row = totals.families.get(key);
    if (!row) { row = { funded: 0, paid: 0, reserved: 0, captures: new Map() }; totals.families.set(key, row); }
    return row;
  };
  const add = (obligation: ApplicationObligation, capture: string | null, role: "funded" | "paid" | "reserved", cents: number) => {
    const row = family(obligation);
    row[role] += cents;
    if (capture !== null) {
      const instrument = row.captures.get(capture) ?? { funded: 0, paid: 0, reserved: 0 };
      instrument[role] += cents;
      row.captures.set(capture, instrument);
    }
  };
  for (const application of state.applications) {
    const source = sources.get(application.sourceLineId);
    const obligation = obligations.get(application.obligationId);
    if (!source || !obligation) throw new Error("Missing application source or obligation");
    const amount = application.amountCents * sign(application.id);
    totals.sources.set(source.id, (totals.sources.get(source.id) ?? 0) + amount);
    totals.obligations.set(obligation.id, (totals.obligations.get(obligation.id) ?? 0) + amount);
    const role = applicationRoleOf(source, obligation);
    if (role === "collect") totals.collected += amount;
    else if (role !== null) add(obligation, source.capture, role === "fund" ? "funded" : "paid", amount);
  }
  for (const reservation of state.reservations) {
    const obligation = obligations.get(reservation.obligationId);
    if (!obligation) throw new Error("Missing reservation obligation");
    add(obligation, reservation.capture, "reserved", reservation.amountCents);
  }
  return totals;
}

export function memberMoneyConservationProblems(state: ApplicationState): { identity: string; problem: string }[] {
  const totals = memberMoneyApplicationTotals(state);
  const problems: { identity: string; problem: string }[] = [];
  for (const source of state.sources) {
    const net = totals.sources.get(source.id) ?? 0;
    if (net < 0 || net > source.amountCents) problems.push({ identity: source.id, problem: "C1_source_cap" });
  }
  for (const [key, family] of totals.families) {
    const root = state.obligations.find((o) => o.key === key && o.kind === "REFUND");
    if (!root || family.funded < 0 || family.paid < 0 || family.funded > root.faceCents || family.paid + family.reserved > root.faceCents) {
      problems.push({ identity: key, problem: "C3_refund_family_cap" });
    }
    for (const [capture, instrument] of family.captures) {
      if (instrument.funded < 0 || instrument.paid < 0 || instrument.paid + instrument.reserved > instrument.funded) {
        problems.push({ identity: `${key}:${capture}`, problem: "C4_capture_cap" });
      }
    }
  }
  return problems;
}
