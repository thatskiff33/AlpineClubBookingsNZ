/**
 * The audit trail behind automatic email-inheritance re-resolution (#2822).
 *
 * MAD-B1 makes a member's effective email source self-correcting, and #2821
 * wired that re-resolution into every writer that can move a member across the
 * usable-source line. This file proves the durable record of those moves: WHEN
 * a member's effective source changed, from WHOM to WHOM, and WHY — answerable
 * without duplicating a single email-address string into the audit archive.
 *
 * MUTATION PROBES — each breaks one owner decision and fails one NAMED test:
 *  - move the audit write in `convergeSubjects` ABOVE `db.member.update` →
 *    "writes no audit row when the pointer update fails" fails (a success event
 *    is recorded for a change that never committed).
 *  - drop the `pointerChanged` guard on the audit write (audit every update) →
 *    "adopts an unaccompanied pointer's choice without auditing a same-source
 *    no-op" fails (D1: a choice-only adoption fills the choice column but the
 *    effective source does not move, so it must emit no event; without the guard
 *    it writes a spurious previousSource === newSource row). The two no-op sweep
 *    tests do NOT pin this — they short-circuit at the earlier `choiceChanged` /
 *    `continue` before the audit line is ever reached.
 *  - route the event through the module `prisma` instead of the passed `db` →
 *    "couples the event to the caller's own client" fails (atomicity: the event
 *    must ride the pointer's transaction).
 *  - classify the event `admin` or `system` to hide it from members → "stays in
 *    the member-visible family domain" fails (D2: category by affected domain,
 *    no support-only broadening).
 *  - swap `retentionClass: "standard"` for critical/diagnostic → "uses standard
 *    retention" fails (D3).
 *  - put an email string in the metadata → "stores IDs and provenance only" and
 *    "never stores an email-address string" fail (D4).
 *  - hardcode the trigger, or claim a human actor for the sweep → "threads the
 *    caller's trigger and actor" / "the sweep is a system-origin event" fail.
 *  - expose metadata/source ids to the member projection → "the member timeline
 *    shows only the generic event" fails.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  AUDIT_CATEGORY_CORRELATION_DOMAIN,
  type AuditCorrelationDomain,
} from "@/lib/audit-categories";

type MemberRow = {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  ageTier: string;
  archivedAt: Date | null;
  cancelledAt: Date | null;
  parentMemberId: string | null;
  secondaryParentId: string | null;
  inheritParentEmail: boolean;
  inheritEmailFromId: string | null;
  inheritEmailChoiceId: string | null;
};

const store = new Map<string, MemberRow>();
let updateCount = 0;
const auditRows: Array<Record<string, unknown>> = [];
/** Tripped if the reconciler ever audits through the module client, not `tx`. */
let moduleAuditCalls = 0;

function seed(rows: Array<Partial<MemberRow> & { id: string }>) {
  store.clear();
  updateCount = 0;
  auditRows.length = 0;
  moduleAuditCalls = 0;
  for (const row of rows) {
    store.set(row.id, {
      firstName: row.id,
      lastName: "Test",
      email: `${row.id}@example.org`,
      ageTier: "ADULT",
      archivedAt: null,
      cancelledAt: null,
      parentMemberId: null,
      secondaryParentId: null,
      inheritParentEmail: true,
      inheritEmailFromId: null,
      inheritEmailChoiceId: null,
      ...row,
    });
  }
}

/** The same small, throw-on-unknown `where` evaluator the reconcile suite uses. */
function matches(row: MemberRow, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (key === "OR") {
      return (condition as Array<Record<string, unknown>>).some((clause) =>
        matches(row, clause),
      );
    }
    if (key === "NOT") {
      return !matches(row, condition as Record<string, unknown>);
    }
    const value = (row as unknown as Record<string, unknown>)[key];
    if (condition === null || typeof condition !== "object") {
      return value === condition;
    }
    const operators = condition as Record<string, unknown>;
    return Object.entries(operators).every(([operator, operand]) => {
      switch (operator) {
        case "in":
          return (operand as unknown[]).includes(value);
        case "not":
          return operand === null ? value !== null : value !== operand;
        case "endsWith":
          return String(value)
            .toLowerCase()
            .endsWith(String(operand).toLowerCase());
        case "mode":
          return true;
        default:
          throw new Error(
            `fake prisma: unsupported operator "${operator}" on "${key}"`,
          );
      }
    });
  });
}

let updateThrows = false;

function makeMemberFake() {
  return {
    async findMany(args: {
      where?: Record<string, unknown>;
      orderBy?: Array<Record<string, "asc" | "desc">> | Record<string, "asc" | "desc">;
      take?: number;
      cursor?: { id: string };
    }) {
      let rows = [...store.values()].filter((row) =>
        args.where ? matches(row, args.where) : true,
      );
      rows.sort((a, b) => a.id.localeCompare(b.id));
      if (args.cursor) {
        const index = rows.findIndex((row) => row.id === args.cursor!.id);
        rows = rows.slice(index + 1);
      }
      const page = typeof args.take === "number" ? rows.slice(0, args.take) : rows;
      return page.map((row) => ({ ...row }));
    },
    async update({ where, data }: { where: { id: string }; data: Partial<MemberRow> }) {
      if (updateThrows) throw new Error("row moved");
      const row = store.get(where.id);
      if (!row) throw new Error(`fake prisma: no member ${where.id}`);
      updateCount += 1;
      Object.assign(row, data);
      return row;
    },
  };
}

/** The `tx` a real caller hands the reconciler; audit rows land here. */
const txClient = {
  member: makeMemberFake(),
  auditLog: {
    async create({ data }: { data: Record<string, unknown> }) {
      auditRows.push(data);
      return data;
    },
  },
};

// The module client is a tripwire: if the reconciler audits through `prisma`
// rather than the transaction client it was handed, atomicity is broken and
// this counter — asserted zero — catches it.
vi.mock("@/lib/prisma", () => ({
  get prisma() {
    return {
      member: makeMemberFake(),
      auditLog: {
        async create() {
          moduleAuditCalls += 1;
          throw new Error("audit must ride the caller's tx client, not prisma");
        },
      },
    };
  },
}));

import {
  EMAIL_INHERITANCE_SOURCE_CHANGED_ACTION,
  reconcileAllEmailInheritance,
  reconcileEmailInheritanceForMemberChange,
  SYSTEM_EMAIL_INHERITANCE_AUDIT_ACTOR,
} from "@/lib/member-email-inheritance";
import {
  getAuditTimelinePage,
  isMemberVisibleAuditCategory,
} from "@/lib/audit-query";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

const db = txClient as unknown as Parameters<
  typeof reconcileEmailInheritanceForMemberChange
>[0];

const PLACEHOLDER = "walk-in@no-email.invalid";

beforeEach(() => {
  store.clear();
  updateCount = 0;
  auditRows.length = 0;
  moduleAuditCalls = 0;
  updateThrows = false;
});

/** A parent with the mailbox; a youth who chose them but resolves to nobody. */
function parentAndWaitingChild() {
  seed([
    { id: "parent", email: "parent@example.org" },
    {
      id: "child",
      ageTier: "YOUTH",
      email: PLACEHOLDER,
      parentMemberId: "parent",
      inheritEmailChoiceId: "parent",
      inheritEmailFromId: null,
    },
  ]);
}

describe("the effective-source change event (#2822)", () => {
  it("threads the caller's trigger and actor onto a repoint, with IDs-only metadata", async () => {
    parentAndWaitingChild();

    await reconcileEmailInheritanceForMemberChange(db, ["parent"], {
      trigger: "family-link-change",
      actorMemberId: "admin-7",
    });

    expect(auditRows).toHaveLength(1);
    expect(moduleAuditCalls).toBe(0);
    const row = auditRows[0]!;
    expect(row.action).toBe(EMAIL_INHERITANCE_SOURCE_CHANGED_ACTION);
    expect(row.category).toBe("family");
    expect(row.actorMemberId).toBe("admin-7");
    expect(row.subjectMemberId).toBe("child");
    expect(row.metadata).toEqual({
      subjectMemberId: "child",
      previousSourceMemberId: null,
      newSourceMemberId: "parent",
      trigger: "family-link-change",
    });
  });

  it("records a clear as the same action with a null new source", async () => {
    seed([
      { id: "parent", email: "parent@example.org" },
      {
        id: "child",
        ageTier: "YOUTH",
        email: PLACEHOLDER,
        parentMemberId: "parent",
        inheritEmailChoiceId: "parent",
        inheritEmailFromId: "parent",
      },
    ]);
    // The parent's address is removed, so the child's pointer must clear.
    store.get("parent")!.email = "deleted-x@deleted.invalid";

    await reconcileEmailInheritanceForMemberChange(db, ["parent"], {
      trigger: "source-member-change",
      actorMemberId: "m-1",
    });

    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]!.action).toBe(EMAIL_INHERITANCE_SOURCE_CHANGED_ACTION);
    expect(auditRows[0]!.metadata).toEqual({
      subjectMemberId: "child",
      previousSourceMemberId: "parent",
      newSourceMemberId: null,
      trigger: "source-member-change",
    });
  });

  it("writes zero rows for a no-op reconciliation", async () => {
    // Already consistent: the child resolves to the parent and stays there.
    seed([
      { id: "parent", email: "parent@example.org" },
      {
        id: "child",
        ageTier: "YOUTH",
        email: PLACEHOLDER,
        parentMemberId: "parent",
        inheritEmailChoiceId: "parent",
        inheritEmailFromId: "parent",
      },
    ]);

    await reconcileEmailInheritanceForMemberChange(db, ["parent"], {
      trigger: "source-member-change",
      actorMemberId: "m-1",
    });

    expect(updateCount).toBe(0);
    expect(auditRows).toHaveLength(0);
  });

  it("adopts an unaccompanied pointer's choice without auditing a same-source no-op", async () => {
    // A legacy / drain-window row: the pointer already names the correct,
    // settled source (the direct parent), but the choice column beside it was
    // never written. Reconciliation ADOPTS the choice (so the update path really
    // runs and the choice column is filled), yet the EFFECTIVE source does not
    // move — the pointer stays on the same parent. It must therefore emit NO
    // audit event: a spurious row here would carry
    // previousSourceMemberId === newSourceMemberId, the D1-forbidden
    // same-effective-source no-op.
    //
    // This is the ONLY scenario that pins the `pointerChanged` audit guard. Every
    // other no-op short-circuits at the earlier `choiceChanged` / `continue`
    // before it ever reaches the audit line, so dropping the guard leaves those
    // tests green; only a choice-only adoption reaches the guard with the pointer
    // unchanged.
    seed([
      { id: "parent", email: "parent@example.org" },
      {
        id: "child",
        ageTier: "YOUTH",
        email: PLACEHOLDER,
        parentMemberId: "parent",
        inheritEmailChoiceId: null,
        inheritEmailFromId: "parent",
      },
    ]);

    await reconcileEmailInheritanceForMemberChange(db, ["child"], {
      trigger: "source-member-change",
      actorMemberId: "m-1",
    });

    // The update path really ran: the choice column was adopted from the pointer.
    expect(updateCount).toBe(1);
    expect(store.get("child")!.inheritEmailChoiceId).toBe("parent");
    // ...and it left the effective source (the pointer) exactly where it was.
    expect(store.get("child")!.inheritEmailFromId).toBe("parent");
    // The effective source never moved, so nothing may be audited.
    expect(auditRows).toHaveLength(0);
  });

  it("writes no audit row when the pointer update fails — no event before commit", async () => {
    parentAndWaitingChild();
    updateThrows = true;

    // An in-transaction caller does NOT swallow the failure; it propagates so
    // the surrounding transaction rolls back. Crucially, no audit row is left.
    await expect(
      reconcileEmailInheritanceForMemberChange(db, ["parent"], {
        trigger: "source-member-change",
        actorMemberId: "m-1",
      }),
    ).rejects.toThrow("row moved");
    expect(auditRows).toHaveLength(0);
  });

  it("keeps the event in the member-visible family domain, not a support-only class", async () => {
    parentAndWaitingChild();
    await reconcileEmailInheritanceForMemberChange(db, ["parent"], {
      trigger: "family-link-change",
      actorMemberId: "admin-7",
    });

    expect(auditRows[0]!.category).toBe("family");
    // family correlates through Membership (support + membership), never the
    // support-only system domain that `admin`/`security`/`system` sit in.
    const domain: AuditCorrelationDomain = AUDIT_CATEGORY_CORRELATION_DOMAIN.family;
    expect(domain).toBe("membership");
    expect(AUDIT_CATEGORY_CORRELATION_DOMAIN.admin).toBe("system");
    expect(isMemberVisibleAuditCategory("family")).toBe(true);
  });

  it("uses standard retention", async () => {
    parentAndWaitingChild();
    await reconcileEmailInheritanceForMemberChange(db, ["parent"], {
      trigger: "family-link-change",
      actorMemberId: "admin-7",
    });
    expect(auditRows[0]!.retentionClass).toBe("standard");
  });

  it("stores IDs and provenance only — never an email-address string", async () => {
    seed([
      { id: "parent", email: "real.parent@example.org" },
      {
        id: "child",
        ageTier: "YOUTH",
        email: "old.family.copy@example.org",
        parentMemberId: "parent",
        inheritEmailChoiceId: "parent",
        inheritEmailFromId: null,
      },
    ]);
    await reconcileEmailInheritanceForMemberChange(db, ["parent"], {
      trigger: "source-member-change",
      actorMemberId: "m-1",
    });

    expect(auditRows).toHaveLength(1);
    const serialized = JSON.stringify(auditRows[0]);
    expect(serialized).not.toContain("@");
    expect(serialized).not.toContain("real.parent");
    expect(serialized).not.toContain("old.family.copy");
  });
});

describe("the daily convergence sweep", () => {
  it("audits only the rows it changed, as a system-origin event", async () => {
    // Two members are examined; only `stale` actually changes (its chosen parent
    // has no address, so its live pointer must clear). `settled` already resolves.
    seed([
      { id: "parentA", email: PLACEHOLDER },
      {
        id: "stale",
        ageTier: "YOUTH",
        email: PLACEHOLDER,
        parentMemberId: "parentA",
        inheritEmailChoiceId: "parentA",
        inheritEmailFromId: "parentA",
      },
      { id: "parentB", email: "parentb@example.org" },
      {
        id: "settled",
        ageTier: "YOUTH",
        email: PLACEHOLDER,
        parentMemberId: "parentB",
        inheritEmailChoiceId: "parentB",
        inheritEmailFromId: "parentB",
      },
    ]);

    const result = await reconcileAllEmailInheritance(db);

    // Examined more than it changed, and only the change was audited.
    expect(result.examined).toBeGreaterThan(auditRows.length);
    expect(auditRows).toHaveLength(1);
    const row = auditRows[0]!;
    expect(row.subjectMemberId).toBe("stale");
    expect(row.actorMemberId).toBe(SYSTEM_EMAIL_INHERITANCE_AUDIT_ACTOR);
    expect((row.metadata as Record<string, unknown>).trigger).toBe(
      "scheduled-sweep",
    );
    expect(moduleAuditCalls).toBe(0);
  });
});

describe("the member-facing projection", () => {
  // A persisted row shaped exactly as the writer stores it.
  const storedRow = {
    id: "audit-1",
    action: EMAIL_INHERITANCE_SOURCE_CHANGED_ACTION,
    memberId: "admin-7",
    targetId: "child",
    details: null,
    ipAddress: "203.0.113.7",
    createdAt: new Date("2026-08-14T00:00:00.000Z"),
    actorMemberId: "admin-7",
    subjectMemberId: "child",
    entityType: "Member",
    entityId: "child",
    category: "family",
    severity: "info",
    outcome: "success",
    summary: "Email inheritance source updated",
    metadata: {
      subjectMemberId: "child",
      previousSourceMemberId: null,
      newSourceMemberId: "parent",
      trigger: "family-link-change",
    },
    requestId: "req-1",
    userAgent: "agent",
    retentionClass: "standard",
  };

  function timelineClient() {
    return {
      auditLog: {
        findMany: async () => [storedRow],
        count: async () => 1,
      },
      member: {
        findMany: async () => [
          { id: "child", firstName: "Sam", lastName: "Young", email: "c@x.org", role: "USER" },
        ],
      },
    };
  }

  it("shows the member only the generic event — no metadata, source ids, request data or drill-down", async () => {
    const page = await getAuditTimelinePage({
      db: timelineClient() as never,
      where: {},
      page: 1,
      pageSize: 10,
      category: "family",
      audience: "member",
      currentMemberId: "child",
      format: CLUB_FORMAT_TEST,
    });

    const entry = page.data[0]!;
    expect(entry.summary).toBe("Email inheritance source updated");
    expect(entry.metadata).toBeNull();
    expect(entry.description).toBeNull();
    expect(entry.drilldowns).toEqual([]);
    expect(entry.requestId).toBeUndefined();
    expect(entry.ipAddress).toBeUndefined();
    expect(entry.userAgent).toBeUndefined();
    expect(entry.retentionClass).toBeUndefined();
    // The other member's id must not leak anywhere in the member's view.
    expect(JSON.stringify(entry)).not.toContain("parent");
  });

  it("still gives an admin the source ids in metadata for the same row", async () => {
    const page = await getAuditTimelinePage({
      db: timelineClient() as never,
      where: {},
      page: 1,
      pageSize: 10,
      category: "family",
      audience: "admin",
      format: CLUB_FORMAT_TEST,
    });

    expect(page.data[0]!.metadata).toEqual(storedRow.metadata);
  });
});
