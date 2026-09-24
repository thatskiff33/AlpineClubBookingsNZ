/**
 * The booking-guest dietary/allergy SNAPSHOT lifecycle (#3029, `INV-MOD-059`).
 *
 * Seeded once, when a guest row is first created, from the linked member's
 * CURRENT profile value and only while the field is ON; carried as it is where
 * the same stay is rebuilt; never re-seeded, erased or moved onto another person
 * by a rebuild; never written back to the profile. The census proves every
 * create site asks for a decision; this file proves what each decision is.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgeTier, type Prisma } from "@prisma/client";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  bookingGuestDietaryCreateData,
  bookingGuestDietarySeeding,
  bookingGuestDietaryUpdateData,
  captureBookingGuestDietaryCarries,
  fillBookingGuestDietaryFromProfileIfEmpty,
  isSameBookingGuestOccupant,
  planGuestRenameDietary,
  planHeldPartyRebuildDietary,
  planHeldPartyRewriteDietary,
  resolveBookingGuestDietary,
} from "@/lib/member-dietary-booking-writes";
import { buildGuestCreateData } from "@/lib/booking-create-guests";
import { toPipelineGuestCreateData } from "@/lib/booking-request-shared";
import { reassignHeldBookingGuests } from "@/lib/booking-request";

const ID = "INV-MOD-059";
const ON = bookingGuestDietarySeeding(true);
const OFF = bookingGuestDietarySeeding(false);
const PROFILE = "Coeliac";

/** A transaction double whose Member rows hold these profile values. */
function profileDb(values: Record<string, string | null>, guestRows: unknown[] = []) {
  const db = {
    member: {
      findMany: vi.fn(async (args: { where: { id: { in: string[] } } }) =>
        args.where.id.in.map((id) => ({ id, dietaryRequirements: values[id] ?? null })),
      ),
    },
    bookingGuest: {
      findMany: vi.fn(async () => guestRows),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    $executeRaw: vi.fn(async () => 0),
  };
  // The mocks stay reachable for assertions; the module sees a transaction client.
  return db as typeof db &
    Pick<Prisma.TransactionClient, "member" | "bookingGuest" | "$executeRaw">;
}

const person = (
  firstName: string,
  memberId: string | null = null,
  ageTier: AgeTier = AgeTier.ADULT,
) => ({ firstName, lastName: "Tester", ageTier, memberId });

const row = (id: string, identity: ReturnType<typeof person>) => ({ id, ...identity });
const PENDING = { memberGuestConsent: { consentStatus: "PENDING" } };

const createData = async (
  db: ReturnType<typeof profileDb>,
  seeding: typeof ON,
  guests: Parameters<typeof resolveBookingGuestDietary>[2],
) => (await resolveBookingGuestDietary(db, seeding, guests)).map(bookingGuestDietaryCreateData);

beforeEach(() => vi.clearAllMocks());

describe(`seeding a new guest row (${ID})`, () => {
  it("a linked member is seeded from their CURRENT profile while the field is ON; a non-member starts empty", async () => {
    const db = profileDb({ "m-1": PROFILE });
    expect(await createData(db, ON, [{ memberId: "m-1" }, { memberId: null }])).toEqual([
      { dietaryRequirements: PROFILE },
      {},
    ]);
    // One read, through the caller's client.
    expect(db.member.findMany).toHaveBeenCalledTimes(1);
  });

  it("the field OFF seeds nothing and reads no profile", async () => {
    const db = profileDb({ "m-1": PROFILE });
    expect(await createData(db, OFF, [{ memberId: "m-1" }])).toEqual([{}]);
    expect(db.member.findMany).not.toHaveBeenCalled();
  });

  it("the snapshot is taken once: a later profile edit does not change the decision already made", async () => {
    const values: Record<string, string | null> = { "m-1": PROFILE };
    const db = profileDb(values);
    const [write] = await resolveBookingGuestDietary(db, ON, [{ memberId: "m-1" }]);
    values["m-1"] = "Changed later";
    expect(bookingGuestDietaryCreateData(write)).toEqual({ dietaryRequirements: PROFILE });
  });

  it("a carried value wins over the profile, is written even while OFF, and a carried null writes nothing", async () => {
    const source = profileDb({}, [
      { id: "old-1", dietaryRequirements: "Trip-specific: no dairy" },
      { id: "old-2", dietaryRequirements: null },
    ]);
    const carries = await captureBookingGuestDietaryCarries(source, "bk-old", ["old-1", "old-2"]);
    // S3: the capture is scoped to its source booking.
    expect(source.bookingGuest.findMany).toHaveBeenCalledWith({
      where: { id: { in: ["old-1", "old-2"] }, bookingId: "bk-old" },
      select: { id: true, dietaryRequirements: true },
    });
    const db = profileDb({ "m-1": PROFILE, "m-2": PROFILE });
    expect(
      await createData(db, OFF, [
        { memberId: "m-1", carriedDietary: carries.get("old-1") },
        { memberId: "m-2", carriedDietary: carries.get("old-2") },
      ]),
    ).toEqual([{ dietaryRequirements: "Trip-specific: no dairy" }, {}]);
    expect(db.member.findMany).not.toHaveBeenCalled();
  });

  it("refuses a hand-made carry or write token", async () => {
    await expect(
      resolveBookingGuestDietary(profileDb({}), ON, [{ carriedDietary: {} as never }]),
    ).rejects.toThrow(/captureBookingGuestDietaryCarries/);
    expect(() => bookingGuestDietaryCreateData({} as never)).toThrow(ID);
    expect(() => bookingGuestDietaryCreateData(undefined)).toThrow(ID);
  });
});

describe(`both shared builders write the decision they are handed (${ID})`, () => {
  it("buildGuestCreateData spreads each guest's own decision, by index", async () => {
    const db = profileDb({ "m-1": PROFILE });
    const dietary = await resolveBookingGuestDietary(db, ON, [{ memberId: null }, { memberId: "m-1" }]);
    const night = new Date("2026-08-01T00:00:00.000Z");
    const priced = { priceCents: 100, perNightCents: [100], nightDates: [night] };
    const rows = buildGuestCreateData(
      [
        { firstName: "Non", lastName: "Member", ageTier: AgeTier.ADULT, isMember: false },
        { firstName: "Mem", lastName: "Ber", ageTier: AgeTier.ADULT, isMember: true, memberId: "m-1" },
      ],
      { guests: [priced, priced] },
      night,
      new Date("2026-08-02T00:00:00.000Z"),
      dietary,
    );
    expect(rows[0]).not.toHaveProperty("dietaryRequirements");
    expect(rows[1]).toHaveProperty("dietaryRequirements", PROFILE);
  });

  it("toPipelineGuestCreateData spreads it too, and refuses a missing decision", async () => {
    const [write] = await resolveBookingGuestDietary(profileDb({ "m-1": PROFILE }), ON, [
      { memberId: "m-1" },
    ]);
    const guest = { firstName: "Mem", lastName: "Ber", memberId: "m-1", nights: [] };
    expect(toPipelineGuestCreateData(guest, write)).toHaveProperty("dietaryRequirements", PROFILE);
    expect(() => toPipelineGuestCreateData(guest, undefined)).toThrow(ID);
  });
});

describe(`a held party deleted and recreated (W13, ${ID})`, () => {
  const old = [
    { ...person("Aroha", "m-a"), dietaryRequirements: "A's note" },
    { ...person("Kid", null, AgeTier.CHILD), dietaryRequirements: "Kid's note" },
    { ...person("Twin"), dietaryRequirements: "Twin 1" },
    { ...person("Twin"), dietaryRequirements: "Twin 2" },
  ];

  it("carries by unique member id or exact non-member name + tier, whatever the order", async () => {
    const db = profileDb({ "m-a": "A's profile", "m-new": "New profile" }, old);
    const writes = await planHeldPartyRebuildDietary(db, ON, "held-1", [
      person("Newcomer", "m-new"),
      person("Kid", null, AgeTier.CHILD),
      person("Aroha", "m-a"),
    ]);
    expect(writes.map(bookingGuestDietaryCreateData)).toEqual([
      { dietaryRequirements: "New profile" },
      { dietaryRequirements: "Kid's note" },
      { dietaryRequirements: "A's note" },
    ]);
  });

  it("never carries an ambiguous key (two identical non-members) and never by position", async () => {
    const db = profileDb({}, old);
    const writes = await planHeldPartyRebuildDietary(db, ON, "held-1", [
      person("Twin"),
      person("Twin"),
      person("Kid", null, AgeTier.YOUTH), // same name, different tier: not the same person
    ]);
    expect(writes.map(bookingGuestDietaryCreateData)).toEqual([{}, {}, {}]);
  });

  it("carries even while OFF, and seeds nobody while OFF", async () => {
    const db = profileDb({ "m-new": "New profile" }, old);
    const writes = await planHeldPartyRebuildDietary(db, OFF, "held-1", [
      person("Aroha", "m-a"),
      person("Newcomer", "m-new"),
    ]);
    expect(writes.map(bookingGuestDietaryCreateData)).toEqual([
      { dietaryRequirements: "A's note" },
      {},
    ]);
  });
});

describe(`a held party rewritten in place, paired by position (W14, ${ID})`, () => {
  it("the same person keeps theirs untouched; a substitute member is seeded; a non-member is cleared", async () => {
    const db = profileDb({ "m-b": "B's profile" });
    const updates = await planHeldPartyRewriteDietary(db, ON, "held-1", [
      { previous: row("r1", person("Aroha", "m-a")), next: person("Aroha", "m-a") },
      { previous: row("r2", person("Kid")), next: person("Kid") },
      { previous: row("r3", person("Aroha", "m-a")), next: person("Bea", "m-b") },
      { previous: row("r4", person("Aroha", "m-a")), next: person("Stranger") },
      { previous: row("r5", person("Kid")), next: person("Other kid") },
      { previous: row("r6", person("Kid")), next: person("Kid", null, AgeTier.CHILD) },
    ]);
    expect(updates.map(bookingGuestDietaryUpdateData)).toEqual([
      {},
      {},
      { dietaryRequirements: "B's profile" },
      { dietaryRequirements: null },
      { dietaryRequirements: null },
      { dietaryRequirements: null },
    ]);
  });

  it("while OFF a substitute is cleared rather than left holding the previous person's note", async () => {
    const db = profileDb({ "m-b": "B's profile" });
    const [update] = await planHeldPartyRewriteDietary(db, OFF, "held-1", [
      { previous: row("r1", person("Aroha", "m-a")), next: person("Bea", "m-b") },
    ]);
    expect(bookingGuestDietaryUpdateData(update)).toEqual({ dietaryRequirements: null });
    expect(db.member.findMany).not.toHaveBeenCalled();
  });

  it("a spelling correction or a placeholder being named is the same person; a different non-member is not (S2)", async () => {
    const db = profileDb({});
    const updates = await planHeldPartyRewriteDietary(db, ON, "held-1", [
      { previous: row("r1", { ...person("Jonh"), lastName: "Smith" }), next: { ...person("John"), lastName: "Smith" } },
      { previous: row("r2", { ...person("Guest"), lastName: "3" }), next: { ...person("Hana"), lastName: "Rewi" } },
      { previous: row("r3", { ...person("John"), lastName: "Smith" }), next: { ...person("Mere"), lastName: "Walker" } },
    ]);
    expect(updates.map(bookingGuestDietaryUpdateData)).toEqual([{}, {}, { dietaryRequirements: null }]);
  });

  it("a non-member row becoming a member keeps a value already there, and seeds an empty one (L1)", async () => {
    const db = profileDb({ "m-b": "B's profile" }, [
      { id: "kept", dietaryRequirements: "Entered by an officer" },
      { id: "empty", dietaryRequirements: null },
    ]);
    const updates = await planHeldPartyRewriteDietary(db, ON, "held-1", [
      { previous: row("kept", person("Bea")), next: person("Bea", "m-b") },
      { previous: row("empty", person("Bea")), next: person("Bea", "m-b") },
    ]);
    expect(updates.map(bookingGuestDietaryUpdateData)).toEqual([
      {},
      { dietaryRequirements: "B's profile" },
    ]);
  });

  it("a non-member replaced by a DIFFERENT member does not keep the non-member's note (N1)", async () => {
    // Held party [Alice Jones (non-member, "coeliac"), ...]; the officer puts
    // member Bob Brown on row 0 at approval.
    const db = profileDb({ "m-bob": "Bob's profile" }, [{ id: "r0", dietaryRequirements: "coeliac" }]);
    const alice = row("r0", { ...person("Alice"), lastName: "Jones" });
    const bob = { ...person("Bob", "m-bob"), lastName: "Brown" };
    const [seeded] = await planHeldPartyRewriteDietary(db, ON, "held-1", [{ previous: alice, next: bob }]);
    expect(bookingGuestDietaryUpdateData(seeded)).toEqual({ dietaryRequirements: "Bob's profile" });
    const [cleared] = await planHeldPartyRewriteDietary(db, OFF, "held-1", [{ previous: alice, next: bob }]);
    expect(bookingGuestDietaryUpdateData(cleared)).toEqual({ dietaryRequirements: null });
  });

  it("a placeholder linked to a member keeps a note already entered on it (N1)", async () => {
    const db = profileDb({ "m-bob": "Bob's profile" }, [{ id: "r0", dietaryRequirements: "Entered on the placeholder" }]);
    const [update] = await planHeldPartyRewriteDietary(db, ON, "held-1", [
      { previous: row("r0", { ...person("Guest"), lastName: "1" }), next: { ...person("Bob", "m-bob"), lastName: "Brown" } },
    ]);
    expect(bookingGuestDietaryUpdateData(update)).toEqual({});
  });

  it("locks the rows before it reads their stored values (F1)", async () => {
    const db = profileDb({}, []);
    const order: string[] = [];
    db.$executeRaw.mockImplementation(async () => {
      order.push("lock");
      return 0;
    });
    db.bookingGuest.findMany.mockImplementation(async () => {
      order.push("read");
      return [];
    });
    await planHeldPartyRewriteDietary(db, ON, "held-1", [
      { previous: row("r0", person("Bea")), next: person("Bea", "m-b") },
    ]);
    expect(order).toEqual(["lock", "read"]);
  });

  it("a substituted member whose consent is pending is cleared, not seeded (S5)", async () => {
    const db = profileDb({ "m-b": "B's profile" });
    const [update] = await planHeldPartyRewriteDietary(db, ON, "held-1", [
      { previous: row("r1", person("Aroha", "m-a")), next: { ...person("Bea", "m-b"), ...PENDING } },
    ]);
    expect(bookingGuestDietaryUpdateData(update)).toEqual({ dietaryRequirements: null });
  });

  it("reassignHeldBookingGuests leaves the same occupant's row alone and clears a substituted one", async () => {
    const tx = {
      bookingGuest: {
        findMany: vi.fn(async () => [
          { id: "g1", consentStatus: null, ...person("Aroha", "m-a") },
          { id: "g2", consentStatus: null, ...person("Kid") },
        ]),
        update: vi.fn(async () => ({})),
      },
      bookingGuestNight: {
        deleteMany: vi.fn(async () => ({ count: 0 })),
        createMany: vi.fn(async () => ({ count: 0 })),
      },
      familyGroupMember: { findMany: vi.fn(async () => []) },
      member: { findMany: vi.fn(async () => []) },
      $executeRaw: vi.fn(async () => 0),
    };
    const guest = (firstName: string, memberId?: string) => ({
      firstName,
      lastName: "Tester",
      ageTier: AgeTier.ADULT,
      isMember: Boolean(memberId),
      memberId,
      stayStart: new Date("2026-08-01T00:00:00.000Z"),
      stayEnd: new Date("2026-08-02T00:00:00.000Z"),
      priceCents: 0,
      nights: [],
    });
    await reassignHeldBookingGuests(
      tx as never,
      "held-1",
      [guest("Aroha", "m-a"), guest("Someone else")],
      {
        bookingOwnerMemberId: "owner-1",
        actor: { kind: "BOOKING_REQUEST", adminMemberId: "admin-1" },
        policy: { wideningEnabled: false, approvalRequired: true, pendingHoldExpiryDays: 0 },
        bookingCheckIn: new Date("2026-08-01T00:00:00.000Z"),
      } as never,
      ON,
    );
    const data = tx.bookingGuest.update.mock.calls.map(
      (call) => (call as unknown as [{ data: Record<string, unknown> }])[0].data,
    );
    expect(data[0]).not.toHaveProperty("dietaryRequirements");
    expect(data[1]).toHaveProperty("dietaryRequirements", null);
  });
});

describe(`a non-member renamed by a modification (S2, ${ID})`, () => {
  it("clears the note only when the rename is somebody else", () => {
    const decide = planGuestRenameDietary([
      { guestId: "typo", previous: { ...person("Jonh"), lastName: "Smith" }, next: { firstName: "John", lastName: "Smith" } },
      { guestId: "named", previous: { ...person("School Child"), lastName: "2" }, next: { firstName: "Tama", lastName: "Ngata" } },
      { guestId: "swap", previous: { ...person("John"), lastName: "Smith" }, next: { firstName: "Mere", lastName: "Walker" } },
    ]);
    expect(bookingGuestDietaryUpdateData(decide("typo"))).toEqual({});
    expect(bookingGuestDietaryUpdateData(decide("named"))).toEqual({});
    expect(bookingGuestDietaryUpdateData(decide("swap"))).toEqual({ dietaryRequirements: null });
    expect(bookingGuestDietaryUpdateData(decide("not-renamed"))).toEqual({});
  });

  it("is the same rule the held-party rewrite uses", () => {
    const previous = { ...person("John"), lastName: "Smith" };
    const next = { ...previous, firstName: "Mere", lastName: "Walker" };
    expect(isSameBookingGuestOccupant(previous, next)).toBe(false);
    expect(isSameBookingGuestOccupant(previous, { ...previous, firstName: "Jhon" })).toBe(true);
  });
});

describe(`consent pending (S5, ${ID})`, () => {
  it("a member guest whose consent is pending is not seeded", async () => {
    const db = profileDb({ "m-1": PROFILE });
    expect(await createData(db, ON, [{ memberId: "m-1", ...PENDING }])).toEqual([{}]);
    expect(db.member.findMany).not.toHaveBeenCalled();
  });

  it("a pending link is not filled; a granted one is", async () => {
    const db = profileDb({ "m-1": PROFILE });
    await fillBookingGuestDietaryFromProfileIfEmpty(db, ON, [{ guestId: "g1", memberId: "m-1", ...PENDING }]);
    expect(db.bookingGuest.updateMany).not.toHaveBeenCalled();
    await fillBookingGuestDietaryFromProfileIfEmpty(db, ON, [
      { guestId: "g1", memberId: "m-1", memberGuestConsent: { consentStatus: "CONFIRMED" } },
    ]);
    expect(db.bookingGuest.updateMany).toHaveBeenCalledWith({
      where: { id: "g1", memberId: "m-1", dietaryRequirements: null },
      data: { dietaryRequirements: PROFILE },
    });
  });

  it("granting consent fills the row inside the consent transaction (source contract)", () => {
    const text = readFileSync(
      path.resolve(__dirname, "../../..", "src/lib/member-guest-consent-service.ts"),
      "utf8",
    );
    const approve = text.slice(text.indexOf('"CONFIRMED",'), text.indexOf('return { outcome: "APPROVED" }'));
    expect(approve).toMatch(/fillBookingGuestDietaryFromProfileIfEmpty\(tx, guestDietarySeeding, \[/);
  });
});

describe(`the held-party rebuild locks the party first (C3, ${ID})`, () => {
  it("takes the row lock before it reads the values", async () => {
    const db = profileDb({}, []);
    const order: string[] = [];
    db.$executeRaw.mockImplementation(async () => {
      order.push("lock");
      return 0;
    });
    db.bookingGuest.findMany.mockImplementation(async () => {
      order.push("read");
      return [];
    });
    await planHeldPartyRebuildDietary(db, ON, "held-1", []);
    expect(order).toEqual(["lock", "read"]);
  });
});

describe(`a placeholder newly linked to a member (W15, ${ID})`, () => {
  it("fills only while ON, only an empty row, and never from an empty profile", async () => {
    const db = profileDb({ "m-1": PROFILE, "m-2": null });
    await fillBookingGuestDietaryFromProfileIfEmpty(db, OFF, [{ guestId: "g1", memberId: "m-1" }]);
    expect(db.bookingGuest.updateMany).not.toHaveBeenCalled();

    await fillBookingGuestDietaryFromProfileIfEmpty(db, ON, [
      { guestId: "g1", memberId: "m-1" },
      { guestId: "g2", memberId: "m-2" },
    ]);
    expect(db.bookingGuest.updateMany).toHaveBeenCalledTimes(1);
    expect(db.bookingGuest.updateMany).toHaveBeenCalledWith({
      where: { id: "g1", memberId: "m-1", dietaryRequirements: null },
      data: { dietaryRequirements: PROFILE },
    });
  });
});

describe(`the rebuild and copy writers (W18, W19, ${ID})`, () => {
  const source = (file: string) =>
    readFileSync(path.resolve(__dirname, "../../..", file), "utf8");

  it("the cross-lodge offer carries every source row's value (W18)", () => {
    const text = source("src/lib/waitlist-cross-lodge.ts");
    expect(text).toMatch(/captureBookingGuestDietaryCarries\(/);
    expect(text).toMatch(/carriedDietary: carriedDietary\.get\(guest\.id\)/);
  });

  it("an admin copy re-seeds and carries nothing from the source booking (W19)", () => {
    const text = source("src/lib/admin-booking-copy.ts");
    expect(text).toMatch(/guestDietarySeeding: await resolveBookingGuestDietarySeeding\(\)/);
    expect(text).not.toMatch(/carriedDietary|captureBookingGuestDietaryCarries/);
  });
});
