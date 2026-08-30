import { strFromU8, strToU8 } from "fflate";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const reconciliationMocks = vi.hoisted(() => ({
  enqueue: vi.fn(async () => 0),
}));
vi.mock("@/lib/adult-member-hosting-policy-reconciliation", () => ({
  enqueueActiveHostingIncidentPolicyReconciliation: reconciliationMocks.enqueue,
}));

import {
  bookingPoliciesExporter,
  bookingPoliciesImporter,
  MINIMUM_STAY_POLICIES_FILE,
} from "@/lib/config-transfer/categories/booking-policies";
import { ADULT_MEMBER_HOSTING_FILE } from "@/lib/config-transfer/categories/adult-member-hosting";
import { parseCsv } from "@/lib/config-transfer/csv";
import type { ExportContext } from "@/lib/config-transfer/export-types";
import type {
  ApplyContext,
  PlanContext,
  ReadDb,
  TxDb,
} from "@/lib/config-transfer/import-types";

const lodge = { id: "lodge-tlr", slug: "tukino" };

const clubPolicy = {
  id: "hosting-club",
  scopeKey: "club-wide",
  lodgeId: null,
  mode: "ADMIN_REVIEW_REQUIRED",
  capacityMode: "HOLD",
  hostScopeSameBooking: null,
  hostScopeSameBookingOwner: null,
  hostScopeSameGroupTrip: null,
  version: 2,
};
const lodgePolicy = {
  id: "hosting-lodge",
  scopeKey: lodge.id,
  lodgeId: lodge.id,
  mode: "INHERIT",
  capacityMode: "NO_HOLD",
  hostScopeSameBooking: null,
  hostScopeSameBookingOwner: null,
  hostScopeSameGroupTrip: null,
  version: 1,
};

const EMPTY_MIN_STAY =
  "scope,name,startDate,endDate,triggerDays,minimumNights,capacityMode,active\n";
// #2569 added the fourth column. A BLANK `hostScopes` cell is the explicit
// inherit option, and that is what every fixture below uses unless it is
// specifically about the new setting — which is how these tests also assert the
// migration promise: a bundle that says nothing about who counts changes nothing.
const HEADER = "scope,mode,capacityMode,hostScopes\n";

function db(hosting: unknown[] = [clubPolicy, lodgePolicy]): ReadDb {
  return {
    lodge: { findMany: vi.fn().mockResolvedValue([lodge]) },
    minimumStayPolicy: { findMany: vi.fn().mockResolvedValue([]) },
    adultMemberHostingPolicy: { findMany: vi.fn().mockResolvedValue(hosting) },
  } as unknown as ReadDb;
}

function planContext(hostingCsv: string, target = db()): PlanContext {
  return {
    db: target,
    files: new Map([
      [MINIMUM_STAY_POLICIES_FILE, strToU8(EMPTY_MIN_STAY)],
      [ADULT_MEMBER_HOSTING_FILE, strToU8(hostingCsv)],
    ]),
    manifest: {} as never,
    mode: "merge",
    resolutions: new Map(),
    selectedCategories: ["booking-policies"],
  };
}

function applyContext(
  hostingCsv: string,
  tx: TxDb,
): ApplyContext {
  return {
    tx,
    files: new Map([
      [MINIMUM_STAY_POLICIES_FILE, strToU8(EMPTY_MIN_STAY)],
      [ADULT_MEMBER_HOSTING_FILE, strToU8(hostingCsv)],
    ]),
    manifest: {} as never,
    mode: "merge",
    resolutions: new Map(),
    actorMemberId: "admin-1",
    imageRemap: new Map(),
    notes: { doorCodesWritten: [] },
  } as ApplyContext;
}

function txDouble(hosting: unknown[] = [clubPolicy, lodgePolicy]) {
  const create = vi.fn().mockResolvedValue({ id: "created" });
  const updateMany = vi.fn().mockResolvedValue({ count: 1 });
  const deleteMany = vi.fn().mockResolvedValue({ count: 1 });
  return {
    create,
    updateMany,
    deleteMany,
    tx: {
      lodge: { findMany: vi.fn().mockResolvedValue([lodge]) },
      minimumStayPolicy: {
        findMany: vi.fn().mockResolvedValue([]),
        create: vi.fn(),
        updateMany: vi.fn(),
        deleteMany: vi.fn(),
      },
      adultMemberHostingPolicy: {
        findMany: vi.fn().mockResolvedValue(hosting),
        create,
        updateMany,
        deleteMany,
      },
    } as unknown as TxDb,
  };
}

describe("adult-member hosting configuration transfer (#2364)", () => {
  it("exports an id-free, version-free file keyed on scope", async () => {
    const entries = await bookingPoliciesExporter.export({
      db: db(),
      includeDoorCodes: false,
      media: { reference: vi.fn() },
    } as ExportContext);
    const entry = entries.find((e) => e.path === ADULT_MEMBER_HOSTING_FILE)!;
    const parsed = parseCsv(strFromU8(entry.bytes));
    expect(parsed.headers).toEqual([
      "scope",
      "mode",
      "capacityMode",
      "hostScopes",
    ]);
    expect(parsed.headers).not.toContain("id");
    expect(parsed.headers).not.toContain("version");
    expect(parsed.rows).toEqual([
      {
        scope: "club-wide",
        mode: "ADMIN_REVIEW_REQUIRED",
        capacityMode: "HOLD",
        // Blank, because the row's three columns are NULL: it did not decide.
        hostScopes: "",
      },
      {
        scope: "lodge:tukino",
        mode: "INHERIT",
        capacityMode: "NO_HOLD",
        hostScopes: "",
      },
    ]);
  });

  it("emits the header for an empty set, so absence still means 'not carried'", async () => {
    const entries = await bookingPoliciesExporter.export({
      db: db([]),
      includeDoorCodes: false,
      media: { reference: vi.fn() },
    } as ExportContext);
    const entry = entries.find((e) => e.path === ADULT_MEMBER_HOSTING_FILE)!;
    expect(entry.rowCount).toBe(0);
    expect(strFromU8(entry.bytes)).toBe(HEADER);
  });

  it("round-trips export -> plan as entirely unchanged", async () => {
    const entries = await bookingPoliciesExporter.export({
      db: db(),
      includeDoorCodes: false,
      media: { reference: vi.fn() },
    } as ExportContext);
    const entry = entries.find((e) => e.path === ADULT_MEMBER_HOSTING_FILE)!;
    const plan = await bookingPoliciesImporter.plan(
      planContext(strFromU8(entry.bytes)),
    );
    expect(plan.errors).toEqual([]);
    const hosting = plan.items.filter(
      (item) => item.entity === "adult-member-hosting-policy",
    );
    expect(hosting).toHaveLength(2);
    expect(hosting.every((item) => item.action === "unchanged")).toBe(true);
  });

  it("plans a create, an update and a delete against a divergent target", async () => {
    const plan = await bookingPoliciesImporter.plan(
      planContext(
        `${HEADER}club-wide,DISABLED,NO_HOLD,\n`,
        db([clubPolicy, lodgePolicy]),
      ),
    );
    expect(plan.errors).toEqual([]);
    const hosting = plan.items.filter(
      (item) => item.entity === "adult-member-hosting-policy",
    );
    expect(hosting).toEqual([
      {
        entity: "adult-member-hosting-policy",
        key: "club-wide",
        action: "update",
        changedFields: expect.arrayContaining(["mode", "capacityMode"]),
      },
      {
        entity: "adult-member-hosting-policy",
        key: "lodge:tukino",
        action: "delete",
      },
    ]);
  });

  it("shows a header-only file as a complete clear, never as a silent no-op", async () => {
    const plan = await bookingPoliciesImporter.plan(planContext(HEADER));
    const hosting = plan.items.filter(
      (item) => item.entity === "adult-member-hosting-policy",
    );
    expect(hosting.map((item) => item.action)).toEqual(["delete", "delete"]);
  });

  it("refuses the whole category when the hosting file is missing", async () => {
    const ctx = planContext(HEADER);
    ctx.files.delete(ADULT_MEMBER_HOSTING_FILE);
    const plan = await bookingPoliciesImporter.plan(ctx);
    expect(plan.errors.join(" ")).toMatch(/adult-member-hosting\.csv is required/);
    expect(plan.items).toEqual([]);
  });

  it("refuses an unknown lodge slug, a club-wide INHERIT and a duplicate scope", async () => {
    for (const [csv, pattern] of [
      [`${HEADER}lodge:nowhere,DISABLED,HOLD,\n`, /does not exist/],
      [`${HEADER}club-wide,INHERIT,HOLD,\n`, /cannot inherit/],
      [`${HEADER}club-wide,DISABLED,HOLD,\nclub-wide,DISABLED,NO_HOLD,\n`, /duplicate row/],
      [`${HEADER}club-wide,SOMETHING,HOLD,\n`, /mode/],
      [`${HEADER}club-wide,DISABLED,MAYBE,\n`, /capacityMode/],
    ] as Array<[string, RegExp]>) {
      const plan = await bookingPoliciesImporter.plan(planContext(csv));
      expect(plan.errors.join(" ")).toMatch(pattern);
      // A replace-set may only classify deletions once the whole incoming set
      // is valid, or a malformed file reads as an intentional clear.
      expect(
        plan.items.filter((i) => i.entity === "adult-member-hosting-policy"),
      ).toEqual([]);
    }
  });

  it("applies with version-guarded updates, creates and deletes", async () => {
    reconciliationMocks.enqueue.mockClear();
    const { tx, create, updateMany, deleteMany } = txDouble();
    const result = await bookingPoliciesImporter.apply(
      applyContext(
        `${HEADER}club-wide,DISABLED,NO_HOLD,\nlodge:tukino,ADMIN_REVIEW_REQUIRED,HOLD,\n`,
        tx,
      ),
    );
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "hosting-club", version: 2 },
      data: {
        mode: "DISABLED",
        capacityMode: "NO_HOLD",
        hostScopeSameBooking: null,
        hostScopeSameBookingOwner: null,
        hostScopeSameGroupTrip: null,
        version: 3,
      },
    });
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "hosting-lodge", version: 1 },
      data: {
        mode: "ADMIN_REVIEW_REQUIRED",
        capacityMode: "HOLD",
        hostScopeSameBooking: null,
        hostScopeSameBookingOwner: null,
        hostScopeSameGroupTrip: null,
        version: 2,
      },
    });
    expect(create).not.toHaveBeenCalled();
    expect(deleteMany).not.toHaveBeenCalled();
    expect(result.updated).toBe(2);
    expect(reconciliationMocks.enqueue).toHaveBeenCalledTimes(1);
    expect(reconciliationMocks.enqueue).toHaveBeenCalledWith(
      {
        beforePolicies: expect.arrayContaining([
          expect.objectContaining(clubPolicy),
          expect.objectContaining(lodgePolicy),
        ]),
      },
      tx,
    );
  });

  it("creates a row with the scope key the CHECK constraint demands", async () => {
    const { tx, create } = txDouble([]);
    await bookingPoliciesImporter.apply(
      applyContext(`${HEADER}lodge:tukino,DISABLED,HOLD,\n`, tx),
    );
    expect(create).toHaveBeenCalledWith({
      data: {
        scopeKey: lodge.id,
        lodgeId: lodge.id,
        version: 1,
        mode: "DISABLED",
        capacityMode: "HOLD",
        hostScopeSameBooking: null,
        hostScopeSameBookingOwner: null,
        hostScopeSameGroupTrip: null,
      },
      select: { id: true },
    });
  });

  it("does not enqueue incident work for an unchanged hosting policy set", async () => {
    reconciliationMocks.enqueue.mockClear();
    const { tx } = txDouble();
    await bookingPoliciesImporter.apply(
      applyContext(
        `${HEADER}club-wide,ADMIN_REVIEW_REQUIRED,HOLD,\nlodge:tukino,INHERIT,NO_HOLD,\n`,
        tx,
      ),
    );
    expect(reconciliationMocks.enqueue).not.toHaveBeenCalled();
  });

  it("aborts the whole import when a row moved under the apply", async () => {
    const { tx } = txDouble();
    (
      tx.adultMemberHostingPolicy.updateMany as ReturnType<typeof vi.fn>
    ).mockResolvedValue({ count: 0 });
    await expect(
      bookingPoliciesImporter.apply(
        applyContext(`${HEADER}club-wide,DISABLED,NO_HOLD,\n`, tx),
      ),
    ).rejects.toThrow(/changed during import/);
  });

  it("carries same-owner coverage as a saveable set (#2576)", async () => {
    const { tx, updateMany } = txDouble();
    await bookingPoliciesImporter.apply(
      applyContext(
        `${HEADER}club-wide,ADMIN_REVIEW_REQUIRED,HOLD,SAME_BOOKING|SAME_BOOKING_OWNER\nlodge:tukino,INHERIT,NO_HOLD,\n`,
        tx,
      ),
    );
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "hosting-club", version: 2 },
      data: {
        mode: "ADMIN_REVIEW_REQUIRED",
        capacityMode: "HOLD",
        hostScopeSameBooking: true,
        hostScopeSameBookingOwner: true,
        // #3037. The cell named two scopes, so the third is written as an
        // explicit `false`: a bundle that does not mention Group Trip cover
        // cannot turn it on, and cannot leave it undecided on a row that decided
        // the rest of the set either.
        hostScopeSameGroupTrip: false,
        version: 3,
      },
    });
  });

  it("carries Group Trip coverage in and out of the bundle (#3037)", async () => {
    // Config transfer is the one path that can write a setting the UI would not
    // let an operator choose, so the new scope has to survive BOTH directions.
    // Import first: a cell naming SAME_GROUP_TRIP must write the column `true`.
    // Reading the cell but dropping the flag is silent — the import reports
    // success and the target keeps the club's old rule.
    const { tx, updateMany } = txDouble();
    await bookingPoliciesImporter.apply(
      applyContext(
        `${HEADER}club-wide,ADMIN_REVIEW_REQUIRED,HOLD,SAME_BOOKING|SAME_GROUP_TRIP
lodge:tukino,INHERIT,NO_HOLD,
`,
        tx,
      ),
    );
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "hosting-club", version: 2 },
      data: {
        mode: "ADMIN_REVIEW_REQUIRED",
        capacityMode: "HOLD",
        hostScopeSameBooking: true,
        hostScopeSameBookingOwner: false,
        hostScopeSameGroupTrip: true,
        version: 3,
      },
    });

    // And export: a stored row with the scope on serialises it, in the canonical
    // order, so an export/import round trip cannot quietly turn it off.
    const groupTripClub = {
      ...clubPolicy,
      hostScopeSameBooking: true,
      hostScopeSameBookingOwner: false,
      hostScopeSameGroupTrip: true,
    };
    const entries = await bookingPoliciesExporter.export({
      db: db([groupTripClub, lodgePolicy]),
      includeDoorCodes: false,
      media: { reference: vi.fn() },
    } as ExportContext);
    const entry = entries.find((e) => e.path === ADULT_MEMBER_HOSTING_FILE)!;
    const parsed = parseCsv(strFromU8(entry.bytes));
    expect(parsed.rows[0].hostScopes).toBe("SAME_BOOKING|SAME_GROUP_TRIP");
  });

  it("plans a Group-Trip-only difference as a real update, never as unchanged", async () => {
    // The scope columns drive `changedFields` as well as the write. A column
    // missing from that list makes a bundle that turns Group Trip cover ON plan
    // as "unchanged" and apply nothing — the operator is told the import
    // succeeded and the setting they came to change is still off.
    const groupTripOff = {
      ...clubPolicy,
      hostScopeSameBooking: true,
      hostScopeSameBookingOwner: false,
      hostScopeSameGroupTrip: false,
    };
    const plan = await bookingPoliciesImporter.plan(
      planContext(
        `${HEADER}club-wide,ADMIN_REVIEW_REQUIRED,HOLD,SAME_BOOKING|SAME_GROUP_TRIP
lodge:tukino,INHERIT,NO_HOLD,
`,
        db([groupTripOff, lodgePolicy]),
      ),
    );
    expect(plan.errors).toEqual([]);
    const club = plan.items.find((item) => item.key === "club-wide")!;
    expect(club.action).toBe("update");
    expect(club.changedFields).toEqual(["hostScopeSameGroupTrip"]);

    // The control: the same bundle against a target that already has it on is
    // genuinely unchanged, so the assertion above is about the FIELD and not
    // about every plan being an update.
    const already = await bookingPoliciesImporter.plan(
      planContext(
        `${HEADER}club-wide,ADMIN_REVIEW_REQUIRED,HOLD,SAME_BOOKING|SAME_GROUP_TRIP
lodge:tukino,INHERIT,NO_HOLD,
`,
        db([
          { ...groupTripOff, hostScopeSameGroupTrip: true },
          lodgePolicy,
        ]),
      ),
    );
    expect(
      already.items.find((item) => item.key === "club-wide")!.action,
    ).toBe("unchanged");
  });

  it("binds the plan fingerprint to the Group Trip column too (#3037)", async () => {
    // The fingerprint is how an apply notices the target moved after the operator
    // read the dry run. A scope column left out of the digest makes a concurrent
    // change to that exact setting invisible, and the apply proceeds against a
    // target its plan no longer describes. Two targets differing ONLY in the new
    // column must therefore produce different fingerprints.
    const base = {
      ...clubPolicy,
      hostScopeSameBooking: true,
      hostScopeSameBookingOwner: false,
      hostScopeSameGroupTrip: false,
    };
    const off = await bookingPoliciesImporter.plan(
      planContext(HEADER, db([base])),
    );
    const on = await bookingPoliciesImporter.plan(
      planContext(HEADER, db([{ ...base, hostScopeSameGroupTrip: true }])),
    );
    const hostingParts = (parts: string[]) =>
      parts.filter((part) => part.startsWith("adult-member-hosting-policy:"));
    expect(hostingParts(off.fingerprintParts)).not.toEqual(
      hostingParts(on.fingerprintParts),
    );
    // The control: the same target twice hashes identically, so the assertion
    // above is about the column and not about the digest being unstable.
    const again = await bookingPoliciesImporter.plan(
      planContext(HEADER, db([base])),
    );
    expect(hostingParts(off.fingerprintParts)).toEqual(
      hostingParts(again.fingerprintParts),
    );
  });

  it("carries an explicit host-scope set, and refuses the shapes the card refuses (#2569)", async () => {
    const { tx, updateMany } = txDouble();
    await bookingPoliciesImporter.apply(
      applyContext(
        `${HEADER}club-wide,ADMIN_REVIEW_REQUIRED,HOLD,SAME_BOOKING\nlodge:tukino,INHERIT,NO_HOLD,\n`,
        tx,
      ),
    );
    // The club decided; the lodge inherits. Two rows, two different meanings for
    // the same pair of columns.
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "hosting-club", version: 2 },
      data: {
        mode: "ADMIN_REVIEW_REQUIRED",
        capacityMode: "HOLD",
        hostScopeSameBooking: true,
        hostScopeSameBookingOwner: false,
        hostScopeSameGroupTrip: false,
        version: 3,
      },
    });

    for (const [csv, pattern] of [
      // An unknown name is a typo, not a scope to ignore.
      [`${HEADER}club-wide,DISABLED,HOLD,SAME_BOOKINGS\n`, /is not one of/],
      [
        `${HEADER}club-wide,DISABLED,HOLD,SAME_BOOKING|SAME_BOOKING\n`,
        /duplicate SAME_BOOKING/,
      ],
      // The scopes the owner removed from the model (#2575, #2576) are unknown
      // NAMES now, not refused-but-recognised ones — a bundle written against the
      // old model is rejected in the dry run rather than half-applied.
      [
        `${HEADER}club-wide,DISABLED,HOLD,ANY_MEMBER_AT_LODGE\n`,
        /is not one of/,
      ],
      [`${HEADER}club-wide,DISABLED,HOLD,NOMINATED_HOST\n`, /is not one of/],
      // An explicit set naming nothing is the one shape the cell cannot mean: blank
      // is inherit, so `SAME_BOOKING|` is an operator half-way through an edit.
      [
        `${HEADER}club-wide,DISABLED,HOLD,SAME_BOOKING|\n`,
        /is not one of/,
      ],
    ] as Array<[string, RegExp]>) {
      const plan = await bookingPoliciesImporter.plan(planContext(csv));
      expect(plan.errors.join(" ")).toMatch(pattern);
      expect(
        plan.items.filter((i) => i.entity === "adult-member-hosting-policy"),
      ).toEqual([]);
    }
  });
});
