import { describe, expect, it, vi } from "vitest";
import { strToU8 } from "fflate";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import { xeroConfigImporter } from "@/lib/config-transfer/categories/xero-config";
import type { TxDb } from "@/lib/config-transfer/import-types";
import { getEffectiveJoiningFee } from "@/lib/authoritative-fees";
import { addDaysDateOnly, getTodayDateOnly } from "@/lib/date-only";

// Config-transfer joining-fee materialisation (#1931, E5 — HIGH-1): a bundle can
// carry joining-fee AMOUNTS in item-code-mappings.csv amountCents (a column the
// runtime no longer reads). Importing such a bundle into a fresh install must
// materialise JoiningFee windows via the same D-R1 fan-out the migration uses —
// otherwise every member joins with no joining fee, silently. (Pre-#1931 bundles
// used the ENTRANCE_FEE category name for these rows; that import compat closed
// in #2131, so only current JOINING_FEE rows reach the fan-out.)

/**
 * The club's zone, named rather than left to `getTodayDateOnly`'s `APP_TIME_ZONE`
 * default, which #3123 deletes. The importer resolves its own "today" through
 * `readClubTimeZoneOutsideRequest()`; prisma is mocked as `{}` here, so that read
 * fails soft to the environment seed and then to `Pacific/Auckland`. Naming it
 * keeps this file's `today` the same day the importer stamps into
 * `effectiveFrom`.
 */
const CLUB_ZONE = "Pacific/Auckland";

const MEMBERSHIP_TYPES = [
  { id: "mt-full", key: "FULL", bookingBehavior: "MEMBER_RATE", ageGroupsApply: true },
  { id: "mt-associate", key: "ASSOCIATE", bookingBehavior: "NON_MEMBER_RATE", ageGroupsApply: true },
  { id: "mt-family", key: "FAMILY", bookingBehavior: "MEMBER_RATE", ageGroupsApply: true },
  { id: "mt-nonmember", key: "NON_MEMBER", bookingBehavior: "NON_MEMBER_RATE", ageGroupsApply: true },
  { id: "mt-school", key: "SCHOOL", bookingBehavior: "MEMBER_RATE", ageGroupsApply: false },
];

type JoiningFeeRow = {
  membershipTypeId: string;
  ageTier: string | null;
  amountCents: number;
  effectiveFrom: Date;
  effectiveTo: Date | null;
};

function makeTx(captures: {
  joiningFeeCreates: JoiningFeeRow[];
  existingWindows?: JoiningFeeRow[];
}): TxDb {
  const noopDelegate = {
    findMany: async () => [],
    findFirst: async () => null,
    findUnique: async () => null,
    create: async () => ({ id: "x" }),
    update: async () => ({}),
    updateMany: async () => ({ count: 0 }),
    deleteMany: async () => ({ count: 0 }),
    upsert: async () => ({ id: "x" }),
  };
  const specific: Record<string, unknown> = {
    membershipType: { ...noopDelegate, findMany: async () => MEMBERSHIP_TYPES },
    joiningFee: {
      ...noopDelegate,
      findMany: async () => [
        ...(captures.existingWindows ?? []),
        ...captures.joiningFeeCreates,
      ],
      create: async ({ data }: { data: JoiningFeeRow }) => {
        captures.joiningFeeCreates.push(data);
        return { id: `jf-${captures.joiningFeeCreates.length}` };
      },
    },
  };
  return new Proxy({} as Record<string, unknown>, {
    get: (_t, prop) => specific[prop as string] ?? noopDelegate,
  }) as unknown as TxDb;
}

function applyCtx(files: Map<string, Uint8Array>, tx: TxDb) {
  return {
    tx,
    files,
    manifest: {} as never,
    mode: "merge" as const,
    resolutions: new Map<string, string>(),
    actorMemberId: "admin-1",
    imageRemap: new Map<string, string>(),
    notes: { doorCodesWritten: [] as string[] },
  };
}

function planCtx(files: Map<string, Uint8Array>, db: TxDb) {
  return {
    db,
    files,
    manifest: {} as never,
    mode: "merge" as const,
    resolutions: new Map<string, string>(),
  };
}

/**
 * A read store for getEffectiveJoiningFee that honours effective windows exactly
 * like the real resolver query: filter to the (membershipTypeId, ageTier) cell,
 * keep windows covering asOf, and return the latest-starting one.
 */
function joiningFeeStore(created: JoiningFeeRow[], existing: JoiningFeeRow[]) {
  const all = [...existing, ...created];
  return {
    joiningFee: {
      findFirst: async ({
        where,
      }: {
        where: {
          membershipTypeId: string;
          ageTier: string | null;
          effectiveFrom: { lte: Date };
        };
      }) => {
        const asOf = where.effectiveFrom.lte;
        const matches = all
          .filter(
            (row) =>
              row.membershipTypeId === where.membershipTypeId &&
              row.ageTier === (where.ageTier ?? null) &&
              row.effectiveFrom.getTime() <= asOf.getTime() &&
              (row.effectiveTo === null || row.effectiveTo.getTime() >= asOf.getTime()),
          )
          .sort((a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime());
        return matches[0]
          ? { amountCents: matches[0].amountCents, effectiveFrom: matches[0].effectiveFrom }
          : null;
      },
    },
  };
}

/** Current item-code CSV carrying JOINING_FEE amounts in the amountCents column. */
function itemCodeBundle(rows: string[]): Map<string, Uint8Array> {
  return new Map<string, Uint8Array>([
    ["xero-config/item-code-mappings.csv", strToU8(
      // The exporter's real current header (ITEM_FIELDS): membershipTypeKey is
      // always emitted, blank for JOINING_FEE rows (HUT_FEE-only column).
      "category,membershipTypeKey,ageTier,seasonType,entranceFeeCategory,itemCode,amountCents\n" +
      rows.join("\n") + "\n",
    )],
  ]);
}

const FULL_ITEM_CODE_BUNDLE = itemCodeBundle([
  "JOINING_FEE,,,,ADULT,ENT-AD,10000",
  "JOINING_FEE,,,,YOUTH,ENT-YO,5000",
  "JOINING_FEE,,,,CHILD,ENT-CH,2500",
  "JOINING_FEE,,,,FAMILY,ENT-FA,20000",
]);

describe("config-transfer joining-fee materialisation (#1931, E5)", () => {
  it("materialises D-R1 fan-out windows from an item-code bundle on a fresh install, and a member then resolves the fee", async () => {
    const captures = { joiningFeeCreates: [] as JoiningFeeRow[] };
    await xeroConfigImporter.apply(applyCtx(FULL_ITEM_CODE_BUNDLE, makeTx(captures)) as never);

    const today = getTodayDateOnly(CLUB_ZONE);
    // Per-tier fan-out to every liable type (FULL, ASSOCIATE) — never to
    // NON_MEMBER, SCHOOL, or the Family type — plus the flat family row:
    // ADULT x2 + YOUTH x2 + CHILD/INFANT x4 + FAMILY flat x1 = 9 open windows.
    expect(captures.joiningFeeCreates).toHaveLength(9);
    for (const liable of ["mt-full", "mt-associate"]) {
      expect(captures.joiningFeeCreates).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ membershipTypeId: liable, ageTier: "ADULT", amountCents: 10000, effectiveFrom: today, effectiveTo: null }),
          expect.objectContaining({ membershipTypeId: liable, ageTier: "YOUTH", amountCents: 5000, effectiveTo: null }),
          expect.objectContaining({ membershipTypeId: liable, ageTier: "CHILD", amountCents: 2500, effectiveTo: null }),
          expect.objectContaining({ membershipTypeId: liable, ageTier: "INFANT", amountCents: 2500, effectiveTo: null }),
        ]),
      );
    }
    expect(captures.joiningFeeCreates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ membershipTypeId: "mt-family", ageTier: null, amountCents: 20000, effectiveTo: null }),
      ]),
    );
    const targetedTypes = new Set(captures.joiningFeeCreates.map((r) => r.membershipTypeId));
    expect(targetedTypes.has("mt-nonmember")).toBe(false);
    expect(targetedTypes.has("mt-school")).toBe(false);

    // End-to-end: the shared resolver finds the materialised windows, so a
    // member joining after the import resolves a real fee (no silent zero).
    const store = {
      joiningFee: {
        findFirst: async ({ where }: { where: { membershipTypeId: string; ageTier: string | null } }) => {
          const match = captures.joiningFeeCreates.find(
            (row) =>
              row.membershipTypeId === where.membershipTypeId &&
              row.ageTier === (where.ageTier ?? null),
          );
          return match
            ? { amountCents: match.amountCents, effectiveFrom: match.effectiveFrom }
            : null;
        },
      },
    };
    const adultFee = await getEffectiveJoiningFee(
      { membershipTypeId: "mt-full", ageTier: "ADULT" }, today, store as never,
    );
    expect(adultFee).toMatchObject({ amountCents: 10000, source: "SCHEDULE" });
    const familyFee = await getEffectiveJoiningFee(
      { membershipTypeId: "mt-family", ageTier: "ADULT" }, today, store as never,
    );
    expect(familyFee).toMatchObject({ amountCents: 20000, source: "SCHEDULE" });
  });

  it("leaves a category alone when the target already has a covering window (deliberate config wins)", async () => {
    const today = getTodayDateOnly(CLUB_ZONE);
    const captures = {
      joiningFeeCreates: [] as JoiningFeeRow[],
      existingWindows: [
        // A covering adult-tier window on ANY liable type marks ADULT covered.
        { membershipTypeId: "mt-full", ageTier: "ADULT", amountCents: 7700, effectiveFrom: addDaysDateOnly(today, -30), effectiveTo: null },
      ],
    };
    await xeroConfigImporter.apply(
      applyCtx(itemCodeBundle(["JOINING_FEE,,,,ADULT,ENT-AD,10000"]), makeTx(captures)) as never,
    );
    expect(captures.joiningFeeCreates).toHaveLength(0);
  });

  it("bounds a materialised window to the day before a cell's future window (no overlap)", async () => {
    const today = getTodayDateOnly(CLUB_ZONE);
    const futureStart = addDaysDateOnly(today, 10);
    const captures = {
      joiningFeeCreates: [] as JoiningFeeRow[],
      existingWindows: [
        // Future-only window: does NOT cover today, so ADULT still materialises,
        // but the mt-full/ADULT cell must be bounded to the day before it.
        { membershipTypeId: "mt-full", ageTier: "ADULT", amountCents: 9900, effectiveFrom: futureStart, effectiveTo: null },
      ],
    };
    await xeroConfigImporter.apply(
      applyCtx(itemCodeBundle(["JOINING_FEE,,,,ADULT,ENT-AD,10000"]), makeTx(captures)) as never,
    );

    const fullAdult = captures.joiningFeeCreates.find(
      (row) => row.membershipTypeId === "mt-full" && row.ageTier === "ADULT",
    );
    const associateAdult = captures.joiningFeeCreates.find(
      (row) => row.membershipTypeId === "mt-associate" && row.ageTier === "ADULT",
    );
    expect(fullAdult?.effectiveTo).toEqual(addDaysDateOnly(futureStart, -1));
    expect(associateAdult?.effectiveTo).toBeNull();
  });

  it("fills an INTER-WINDOW gap between two future windows (#1931 F1: not billed $0 mid-gap)", async () => {
    const today = getTodayDateOnly(CLUB_ZONE);
    const gapStart = addDaysDateOnly(today, 10); // window A: [today+10, today+20]
    const gapEnd = addDaysDateOnly(today, 20);
    const tailStart = addDaysDateOnly(today, 40); // window B: [today+40, null]
    const captures = {
      joiningFeeCreates: [] as JoiningFeeRow[],
      existingWindows: [
        // Two mt-full/ADULT windows leaving today..today+9, today+21..today+39
        // uncovered. Neither covers today, so ADULT materialises.
        { membershipTypeId: "mt-full", ageTier: "ADULT", amountCents: 9900, effectiveFrom: gapStart, effectiveTo: gapEnd },
        { membershipTypeId: "mt-full", ageTier: "ADULT", amountCents: 9900, effectiveFrom: tailStart, effectiveTo: null },
      ],
    };
    await xeroConfigImporter.apply(
      applyCtx(itemCodeBundle(["JOINING_FEE,,,,ADULT,ENT-AD,10000"]), makeTx(captures)) as never,
    );

    const fullAdultFills = captures.joiningFeeCreates
      .filter((r) => r.membershipTypeId === "mt-full" && r.ageTier === "ADULT")
      .sort((a, b) => a.effectiveFrom.getTime() - b.effectiveFrom.getTime());
    // Leading gap + inter-window gap (no tail — window B is open-ended).
    expect(fullAdultFills).toHaveLength(2);
    expect(fullAdultFills[0]).toMatchObject({
      amountCents: 10000,
      effectiveFrom: today,
      effectiveTo: addDaysDateOnly(gapStart, -1),
    });
    expect(fullAdultFills[1]).toMatchObject({
      amountCents: 10000,
      effectiveFrom: addDaysDateOnly(gapEnd, 1),
      effectiveTo: addDaysDateOnly(tailStart, -1),
    });

    // The previously-uncovered mid-gap date today+25 now resolves the legacy
    // amount (10000), not a silent $0.
    const store = joiningFeeStore(captures.joiningFeeCreates, captures.existingWindows);
    const midGap = await getEffectiveJoiningFee(
      { membershipTypeId: "mt-full", ageTier: "ADULT" }, addDaysDateOnly(today, 25), store as never,
    );
    expect(midGap).toMatchObject({ amountCents: 10000, source: "SCHEDULE" });
  });

  it("fills the open TAIL after a bounded last window (#1931 F1: not billed $0 after it lapses)", async () => {
    const today = getTodayDateOnly(CLUB_ZONE);
    const boundedStart = addDaysDateOnly(today, 10);
    const boundedEnd = addDaysDateOnly(today, 50); // window: [today+10, today+50]
    const captures = {
      joiningFeeCreates: [] as JoiningFeeRow[],
      existingWindows: [
        { membershipTypeId: "mt-full", ageTier: "ADULT", amountCents: 9900, effectiveFrom: boundedStart, effectiveTo: boundedEnd },
      ],
    };
    await xeroConfigImporter.apply(
      applyCtx(itemCodeBundle(["JOINING_FEE,,,,ADULT,ENT-AD,10000"]), makeTx(captures)) as never,
    );

    const fullAdultFills = captures.joiningFeeCreates
      .filter((r) => r.membershipTypeId === "mt-full" && r.ageTier === "ADULT")
      .sort((a, b) => a.effectiveFrom.getTime() - b.effectiveFrom.getTime());
    // Leading gap [today, today+9] + open tail [today+51, null].
    expect(fullAdultFills).toHaveLength(2);
    expect(fullAdultFills[0]).toMatchObject({
      effectiveFrom: today,
      effectiveTo: addDaysDateOnly(boundedStart, -1),
    });
    expect(fullAdultFills[1]).toMatchObject({
      amountCents: 10000,
      effectiveFrom: addDaysDateOnly(boundedEnd, 1),
      effectiveTo: null,
    });

    // A date past the bounded window (today+100) now resolves the legacy amount,
    // not a silent $0.
    const store = joiningFeeStore(captures.joiningFeeCreates, captures.existingWindows);
    const afterLapse = await getEffectiveJoiningFee(
      { membershipTypeId: "mt-full", ageTier: "ADULT" }, addDaysDateOnly(today, 100), store as never,
    );
    expect(afterLapse).toMatchObject({ amountCents: 10000, source: "SCHEDULE" });
  });

  it("a genuinely fee-free install (no legacy amount) still resolves NONE (regression)", async () => {
    const captures = { joiningFeeCreates: [] as JoiningFeeRow[] };
    await xeroConfigImporter.apply(
      applyCtx(itemCodeBundle(["JOINING_FEE,,,,ADULT,ENT-AD,"]), makeTx(captures)) as never,
    );
    expect(captures.joiningFeeCreates).toHaveLength(0);

    const store = joiningFeeStore([], []);
    const fee = await getEffectiveJoiningFee(
      { membershipTypeId: "mt-full", ageTier: "ADULT" }, getTodayDateOnly(CLUB_ZONE), store as never,
    );
    expect(fee).toMatchObject({ amountCents: null, source: "NONE" });
  });

  it("ignores zero/absent amounts (no windows materialised from item-code-only rows)", async () => {
    const captures = { joiningFeeCreates: [] as JoiningFeeRow[] };
    await xeroConfigImporter.apply(
      applyCtx(itemCodeBundle(["JOINING_FEE,,,,ADULT,ENT-AD,", "JOINING_FEE,,,,YOUTH,ENT-YO,0"]), makeTx(captures)) as never,
    );
    expect(captures.joiningFeeCreates).toHaveLength(0);
  });

  it("plan previews the materialisation and binds coverage into the fingerprint", async () => {
    const captures = { joiningFeeCreates: [] as JoiningFeeRow[] };
    const plan = await xeroConfigImporter.plan(planCtx(FULL_ITEM_CODE_BUNDLE, makeTx(captures)) as never);

    expect(plan.errors).toEqual([]);
    expect(plan.items).toEqual(
      expect.arrayContaining([
        { entity: "joining-fee-window", key: "ADULT", action: "create" },
        { entity: "joining-fee-window", key: "FAMILY", action: "create" },
      ]),
    );
    expect(plan.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining("Joining-fee windows will be created")]),
    );
    expect(plan.fingerprintParts).toEqual(
      expect.arrayContaining([
        "joining-fee-coverage:ADULT:absent",
        "joining-fee-coverage:CHILD:absent",
        "joining-fee-coverage:FAMILY:absent",
        "joining-fee-coverage:YOUTH:absent",
      ]),
    );
    // Plan is a dry run: nothing was written.
    expect(captures.joiningFeeCreates).toHaveLength(0);
  });
});
