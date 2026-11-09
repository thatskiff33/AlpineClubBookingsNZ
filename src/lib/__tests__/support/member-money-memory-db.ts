/**
 * An in-memory Prisma transaction client for the member-money receipt paths (#4516): enough of the delegates the
 * real plan builder, store, receipt hook and receipt census call that a unit test runs them unmocked, and asserts
 * on the journal rows they write. `where` is the shared `prisma-where.ts` evaluator; relations resolve through
 * foreign keys, as PostgreSQL's would. The application-state projection mirrors
 * `member_money_application_state` (migration 20261210080000). The realdb suites prove the database itself: its
 * deferred checks, locks and the real projection. This double models only the unique keys a writer here relies on.
 */
import type { Prisma } from "@prisma/client";
import { MemberMoneyApplicationState, type ApplicationState } from "@/lib/member-money/internal/application-state";
import { matchesWhere, type WhereInput } from "./prisma-where";

type Row = Record<string, unknown>;
type Relation = { model: string; many: boolean; local: string; foreign: string };

const COLUMNS: Record<string, readonly string[]> = {
  memberMoneyEvent: ["id", "eventKey", "kind", "origin", "sourceKind", "sourceIdentity", "sourceVersion", "payloadHash", "actorMemberId", "reason", "effectiveAt", "effectiveDate", "recordedAt"],
  memberMoneyJournal: ["id", "eventId", "currency", "policyVersion", "codingVersion", "expectedLineCount", "expectedObligationCount", "expectedApplicationCount", "reversesJournalId"],
  memberMoneySourceLink: ["id", "journalId", "sourceKind", "sourceId", "sourceVersion", "bookingLedgerLineId"],
  memberMoneySourcePosting: ["id", "journalId", "sourceLinkId", "lineId"],
  memberMoneyObligation: ["id", "journalId", "obligationKey", "kind", "debtorKind", "memberId", "organisationId", "faceCents", "evidence"],
  memberMoneyLine: ["id", "journalId", "sourceLinkId", "account", "side", "amountCents", "debtorKind", "memberId", "organisationId", "bookingId", "lodgeId",
    "creditLotId", "chargeIdentity", "refundIdentity", "grossCents", "netCents", "taxCents", "taxCode", "evidence", "originalLineId", "obligationId"],
  memberMoneyApplication: ["id", "applicationKey", "journalId", "sourceLineId", "obligationId", "amountCents", "reversesApplicationId"],
  payment: ["id", "bookingId", "manuallyMarkedPaidAt"],
  booking: ["id", "lodgeId", "memberId", "organisationId"],
  paymentTransaction: ["id", "paymentId", "source", "kind", "status", "amountCents", "stripePaymentIntentId", "reason"],
  bookingLedgerLine: ["id", "bookingId", "side", "kind", "anchorId", "reversesLineId", "amountCents", "postedAt", "postingKey"],
};

const one = (model: string, local: string, foreign = "id"): Relation => ({ model, many: false, local, foreign });
const many = (model: string, foreign: string, local = "id"): Relation => ({ model, many: true, local, foreign });
const RELATIONS: Record<string, Record<string, Relation>> = {
  memberMoneyEvent: { journal: { model: "memberMoneyJournal", many: false, local: "id", foreign: "eventId" } },
  memberMoneyJournal: { event: one("memberMoneyEvent", "eventId"), reversedBy: { model: "memberMoneyJournal", many: false, local: "id", foreign: "reversesJournalId" },
    sources: many("memberMoneySourceLink", "journalId"), lines: many("memberMoneyLine", "journalId"), applications: many("memberMoneyApplication", "journalId") },
  memberMoneySourceLink: { bookingLedgerLine: one("bookingLedgerLine", "bookingLedgerLineId") },
  memberMoneyLine: { journal: one("memberMoneyJournal", "journalId"), obligation: one("memberMoneyObligation", "obligationId") },
  memberMoneyApplication: { journal: one("memberMoneyJournal", "journalId"), obligation: one("memberMoneyObligation", "obligationId"),
    reversedBy: { model: "memberMoneyApplication", many: false, local: "id", foreign: "reversesApplicationId" } },
  payment: { booking: one("booking", "bookingId"), transactions: many("paymentTransaction", "paymentId") },
  paymentTransaction: { payment: one("payment", "paymentId") },
};

/** The unique keys a writer here relies on: a replayed event, one source link per identity, one reversal each. */
const UNIQUE: Record<string, readonly (readonly string[])[]> = {
  memberMoneyEvent: [["eventKey"]],
  memberMoneySourceLink: [["sourceKind", "sourceId", "sourceVersion"], ["bookingLedgerLineId"]],
  memberMoneyObligation: [["obligationKey"]],
  memberMoneyJournal: [["eventId"], ["reversesJournalId"]],
  memberMoneyApplication: [["applicationKey"], ["reversesApplicationId"]],
};

export class MemberMoneyMemoryDb {
  readonly tables: Record<string, Row[]> = Object.fromEntries(Object.keys(COLUMNS).map((model) => [model, []]));
  /** Every write, in order, as `model.operation`. */
  readonly writes: string[] = [];
  readonly tx: Prisma.TransactionClient;
  /** What `assertGlobalLockHeld` reads: whether this transaction holds `pg_advisory_xact_lock(1)`. */
  globalLockHeld = false;

  constructor() {
    const delegates = Object.fromEntries(Object.keys(COLUMNS).map((model) => [model, this.delegate(model)]));
    this.tx = {
      ...delegates,
      $executeRaw: async (sql: TemplateStringsArray) => {
        if (!sql.join("?").includes(`FROM "Payment"`)) throw new Error(`memory db: unmodelled $executeRaw ${sql.join("?")}`);
        return 1;
      },
      $queryRaw: async (sql: TemplateStringsArray, ...values: unknown[]) => {
        const text = sql.join("?");
        if (text.includes("pg_locks")) return [{ held: this.globalLockHeld }];
        if (!text.includes("member_money_application_state")) throw new Error(`memory db: unmodelled $queryRaw ${text}`);
        return [{ state: this.applicationState(values[0] as string) }];
      },
    } as unknown as Prisma.TransactionClient;
  }

  /** Insert fixture rows, every unnamed column null. */
  seed(model: string, ...rows: Row[]): Row[] {
    const full = rows.map((row) => ({ ...Object.fromEntries(COLUMNS[model]!.map((c) => [c, null])), ...row }));
    this.tables[model]!.push(...full);
    return full;
  }

  rows(model: string, where?: WhereInput): Row[] {
    // Prisma reads `relation: null` on a to-one relation as "no related row", the shared evaluator's `is: null`.
    const normal = where && Object.fromEntries(Object.entries(where).map(([key, value]) =>
      [key, value === null && RELATIONS[model]?.[key] && !RELATIONS[model]![key]!.many ? { is: null } : value]));
    return this.tables[model]!.filter((row) => matchesWhere(row, normal, { label: `memory db (${model})`,
      column: (_, key) => COLUMNS[model]!.includes(key),
      relation: (r, key) => {
        const relation = RELATIONS[model]?.[key];
        if (!relation) return undefined;
        const related = this.related(r, relation);
        return { related, matches: (rel, nested) => this.rows(relation.model, nested).includes(rel as Row) };
      } }));
  }

  private related(row: Row, relation: Relation): Row | Row[] | null {
    const found = this.tables[relation.model]!.filter((r) => row[relation.local] !== null && r[relation.foreign] === row[relation.local]);
    return relation.many ? found : found[0] ?? null;
  }

  private project(model: string, row: Row, args: { select?: Row; include?: Row }): Row {
    const out: Row = args.select ? {} : { ...row };
    for (const [key, spec] of Object.entries(args.select ?? args.include ?? {})) {
      if (!spec) continue;
      const relation = RELATIONS[model]?.[key];
      if (!relation) { if (!COLUMNS[model]!.includes(key)) throw new Error(`memory db: ${model}.${key} is not modelled`); out[key] = row[key]; continue; }
      const nested = spec === true ? {} : spec as { where?: WhereInput; select?: Row; include?: Row; orderBy?: unknown };
      const related = this.related(row, relation);
      if (relation.many) {
        const list = this.sorted(this.rows(relation.model, nested.where).filter((r) => (related as Row[]).includes(r)), nested.orderBy);
        out[key] = list.map((r) => this.project(relation.model, r, nested));
      } else out[key] = related ? this.project(relation.model, related as Row, nested) : null;
    }
    return out;
  }

  private sorted(rows: Row[], orderBy: unknown): Row[] {
    const order = (Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []) as Record<string, "asc" | "desc">[];
    const value = (v: unknown) => (v instanceof Date ? v.getTime() : v) as string | number;
    return [...rows].sort((a, b) => {
      for (const o of order) for (const [k, dir] of Object.entries(o)) {
        if (value(a[k]) === value(b[k])) continue;
        return (value(a[k]) < value(b[k]) ? -1 : 1) * (dir === "desc" ? -1 : 1);
      }
      return 0;
    });
  }

  private find(model: string, args: { where?: WhereInput; orderBy?: unknown; take?: number; skip?: number; cursor?: { id: string } }): Row[] {
    let rows = this.sorted(this.rows(model, args.where), args.orderBy);
    if (args.cursor) rows = rows.slice(rows.findIndex((r) => r.id === args.cursor!.id));
    rows = rows.slice(args.skip ?? 0);
    return args.take === undefined ? rows : rows.slice(0, args.take);
  }

  private insert(model: string, data: Row[], skipDuplicates: boolean): number {
    let count = 0;
    for (const row of data) {
      const clash = (UNIQUE[model] ?? []).some((key) => this.tables[model]!.some((r) => key.every((k) => row[k] !== null && row[k] !== undefined && r[k] === row[k])));
      if (clash && skipDuplicates) continue;
      if (clash) throw new Error(`memory db: unique violation on ${model} ${JSON.stringify(row)}`);
      // Recorded in insert order, a millisecond apart from the frozen test day: no wall clock.
      this.seed(model, model === "memberMoneyEvent" ? { recordedAt: new Date(Date.UTC(2026, 6, 1) + this.tables[model]!.length), ...row } : row);
      count++;
    }
    this.writes.push(`${model}.createMany`);
    return count;
  }

  private delegate(model: string) {
    type Args = { where?: WhereInput; select?: Row; include?: Row; orderBy?: unknown; take?: number; skip?: number; cursor?: { id: string } };
    const first = (args: Args) => { const row = this.find(model, args)[0]; return row ? this.project(model, row, args) : null; };
    const orThrow = (args: Args) => { const row = first(args); if (!row) throw new Error(`memory db: no ${model} matches`); return row; };
    return {
      findUnique: async (args: Args) => first(args),
      findFirst: async (args: Args) => first(args),
      findUniqueOrThrow: async (args: Args) => orThrow(args),
      findFirstOrThrow: async (args: Args) => orThrow(args),
      findMany: async (args: Args = {}) => this.find(model, args).map((row) => this.project(model, row, args)),
      count: async (args: Args = {}) => this.rows(model, args.where).length,
      aggregate: async (args: { where?: WhereInput; _min: Record<string, true> }) => {
        const rows = this.rows(model, args.where);
        return { _min: Object.fromEntries(Object.keys(args._min).map((key) =>
          [key, this.sorted(rows.filter((r) => r[key] !== null), { [key]: "asc" })[0]?.[key] ?? null])) };
      },
      createMany: async (args: { data: Row[]; skipDuplicates?: boolean }) => ({ count: this.insert(model, args.data, args.skipDuplicates === true) }),
    };
  }

  /** `member_money_application_state(booking)`, as the SQL function projects it. */
  applicationState(bookingId: string): ApplicationState {
    const links = new Map(this.tables.memberMoneySourceLink!.map((l) => [l.id, l]));
    const journals = new Map(this.tables.memberMoneyJournal!.map((j) => [j.id, j]));
    const lines = this.tables.memberMoneyLine!;
    const sources = lines.filter((l) => l.bookingId === bookingId).map((l) => {
      const link = links.get(l.sourceLinkId as string)!;
      const transaction = link.sourceKind === "PAYMENT" ? this.tables.paymentTransaction!.find((t) => t.id === link.sourceId) : undefined;
      return { id: l.id, sourceKind: link.sourceKind, account: l.account, side: l.side, amountCents: l.amountCents, debtorKind: l.debtorKind,
        memberId: l.memberId, organisationId: l.organisationId, currency: journals.get(l.journalId as string)!.currency, bookingId: l.bookingId,
        obligationId: l.obligationId, capture: transaction?.stripePaymentIntentId ?? null, reversed: lines.some((r) => r.originalLineId === l.id) };
    });
    const obligations = this.tables.memberMoneyObligation!.filter((o) => lines.some((l) => l.obligationId === o.id && l.bookingId === bookingId))
      .map((o) => ({ id: o.id, key: o.obligationKey, kind: o.kind, faceCents: o.faceCents, debtorKind: o.debtorKind, memberId: o.memberId,
        organisationId: o.organisationId, currency: journals.get(o.journalId as string)!.currency }));
    const applications = this.tables.memberMoneyApplication!.filter((a) => sources.some((s) => s.id === a.sourceLineId))
      .map((a) => ({ id: a.id, sourceLineId: a.sourceLineId, obligationId: a.obligationId, amountCents: a.amountCents, reversesApplicationId: a.reversesApplicationId }));
    // Through the projection's own schema, so a row this double holds in the wrong shape fails here.
    return MemberMoneyApplicationState.parse({ sources, obligations, applications, reservations: [] });
  }
}
