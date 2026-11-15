import type { Prisma } from "@prisma/client";
import { capProblem } from "./cap-problems";
import {
  applicationRoleOf,
  memberMoneyApplicationTotals,
  memberMoneyConservationProblems,
  sameApplicationDebtor,
  type ApplicationSource,
  type ApplicationState,
} from "./application-state";
import { MemberMoneyPlanError, type BuiltBatch } from "./plan";

type Db = Prisma.TransactionClient;

/**
 * #4519 (Ledger M7): applications that name no booking anywhere, such as a
 * subscription receipt collecting its charge's obligation (R08). The booking
 * path (`prepareApplications` in `store.ts`) serialises on the booking's Payment
 * row and reads the booking's whole population; a member-level obligation has
 * neither, so this reads exactly the obligations and source lines the batch
 * names, with every application on them, and holds the same rules: shape,
 * debtor and currency, exact reversals, C1 on each source, and a collect never
 * taking an obligation past its face (C2's member-level form). Only a collect
 * is allowed: refund funding and pay applications are booking-scoped (M4).
 *
 * PRECONDITION, the caller's: it holds a row lock that every writer applying to
 * these obligations takes (the subscription doors lock the charge row), so the
 * state read here stays true until commit.
 */
export async function prepareMemberLevelApplications(
  db: Db, batch: BuiltBatch, lineIds: string[], applicationIds: string[],
): Promise<ApplicationState> {
  const state = await readMemberLevelApplicationState(db, batch);
  const originalState = structuredClone(state);
  for (const obligation of batch.obligations) state.obligations.push({
    id: obligation.key, key: obligation.key, kind: obligation.kind, faceCents: obligation.faceCents,
    debtorKind: obligation.debtorKind, memberId: obligation.memberId, organisationId: obligation.organisationId, currency: batch.journal.currency,
  });
  for (const [index, line] of batch.lines.entries()) {
    state.sources.push({ ...line, sourceKind: batch.sources[line.source]!.kind, id: lineIds[index]!, currency: batch.journal.currency, reversed: false,
      obligationId: state.obligations.find((o) => o.key === line.obligationKey)?.id ?? null, capture: null });
  }
  const problems: string[] = [];
  for (const [index, application] of batch.applications.entries()) {
    const sourceId = "lineId" in application.source ? application.source.lineId : lineIds[application.source.line]!;
    const source = state.sources.find((s) => s.id === sourceId);
    const obligation = state.obligations.find((o) => o.key === application.obligationKey);
    if (!source || !obligation) { problems.push("application source or obligation does not exist"); continue; }
    if (applicationRoleOf(source, obligation) !== "collect" || application.reservationAttemptKey) problems.push("a member-level application may only collect");
    if (!sameApplicationDebtor(source, obligation) || source.currency !== batch.journal.currency) problems.push("application shape, currency or debtor mismatch");
    if (source.reversed && !application.reversesApplicationId) problems.push("cannot apply a reversed source");
    if (application.reversesApplicationId) {
      const original = state.applications.find((a) => a.id === application.reversesApplicationId);
      if (!original || original.sourceLineId !== source.id || original.obligationId !== obligation.id || original.amountCents !== application.amountCents
        || state.applications.some((a) => a.reversesApplicationId === original.id)) problems.push("application reversal is not an exact unreversed application");
    }
    state.applications.push({ id: applicationIds[index]!, sourceLineId: source.id, obligationId: obligation.id, amountCents: application.amountCents,
      reversesApplicationId: application.reversesApplicationId });
  }
  if (problems.length) throw new MemberMoneyPlanError(problems);
  problems.push(...memberMoneyConservationProblems(state).map((p) => capProblem(p.problem, p.identity)));
  const applied = memberMoneyApplicationTotals(state).obligations;
  for (const obligation of state.obligations) {
    const net = applied.get(obligation.id) ?? 0;
    if (obligation.kind === "CHARGE" && (net < 0 || net > obligation.faceCents)) problems.push(`C2: collect exceeds obligation ${obligation.key}'s face`);
  }
  if (problems.length) throw new MemberMoneyPlanError(problems);
  return originalState;
}

const LINE_SELECT = {
  id: true, account: true, side: true, amountCents: true, debtorKind: true, memberId: true, organisationId: true,
  bookingId: true, obligationId: true, journal: { select: { currency: true } }, source: { select: { sourceKind: true } },
  reversedBy: { select: { id: true } },
} as const;
const OBLIGATION_SELECT = {
  id: true, obligationKey: true, kind: true, faceCents: true, debtorKind: true, memberId: true, organisationId: true,
  journal: { select: { currency: true } },
} as const;

/** The named obligations and source lines, every application on either, and whatever those applications name. */
async function readMemberLevelApplicationState(db: Db, batch: BuiltBatch): Promise<ApplicationState> {
  const planned = new Set(batch.obligations.map((o) => o.key));
  const keys = [...new Set(batch.applications.map((a) => a.obligationKey))].filter((key) => !planned.has(key));
  const lineIds = batch.applications.flatMap((a) => "lineId" in a.source ? [a.source.lineId] : []);
  const named = keys.length ? await db.memberMoneyObligation.findMany({ where: { obligationKey: { in: keys } }, select: OBLIGATION_SELECT }) : [];
  const namedIds = named.map((o) => o.id);
  if (namedIds.length && await db.memberMoneyLine.findFirst({ where: { obligationId: { in: namedIds }, bookingId: { not: null } }, select: { id: true } })) {
    throw new MemberMoneyPlanError(["a member-level application names a booking's obligation"]);
  }
  const applications = namedIds.length || lineIds.length ? await db.memberMoneyApplication.findMany({
    where: { OR: [{ obligationId: { in: namedIds } }, { sourceLineId: { in: lineIds } }] },
    select: { id: true, sourceLineId: true, obligationId: true, amountCents: true, reversesApplicationId: true },
  }) : [];
  const otherIds = [...new Set(applications.map((a) => a.obligationId))].filter((id) => !namedIds.includes(id));
  const obligations = otherIds.length
    ? [...named, ...await db.memberMoneyObligation.findMany({ where: { id: { in: otherIds } }, select: OBLIGATION_SELECT })]
    : named;
  const sourceIds = [...new Set([...lineIds, ...applications.map((a) => a.sourceLineId)])];
  const lines = sourceIds.length ? await db.memberMoneyLine.findMany({ where: { id: { in: sourceIds } }, select: LINE_SELECT }) : [];
  return {
    sources: lines.map(({ journal, source, reversedBy, ...line }): ApplicationSource => ({
      ...line, sourceKind: source.sourceKind, currency: journal.currency, capture: null, reversed: reversedBy !== null,
    })),
    obligations: obligations.map(({ obligationKey, journal, ...obligation }) => ({ ...obligation, key: obligationKey, currency: journal.currency })),
    applications,
    reservations: [],
  };
}
