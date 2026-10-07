import { describe, expect, it, vi } from "vitest";
import { bookingGuestDietarySeeding } from "@/lib/member-dietary-booking-writes";

/*
  #3029 S2 (`INV-MOD-059`): a modification that renames a NON-MEMBER guest to a
  different person clears their dietary note at the `applyGuestChanges` write;
  a spelling correction, or a generated placeholder being named, leaves it
  untouched. The decision is `isSameBookingGuestOccupant`, the rule the
  held-party rewrite uses too.
*/

vi.mock("@/lib/prisma", () => ({
  prisma: { booking: { findUnique: vi.fn() } },
}));

const CHECK_IN = new Date("2026-08-10T00:00:00.000Z");
const CHECK_OUT = new Date("2026-08-11T00:00:00.000Z");

function fakeTx() {
  const updates: Array<{ where: { id: string }; data: Record<string, unknown> }> = [];
  return {
    updates,
    tx: {
      bookingGuest: {
        update: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
          updates.push(args);
          return {};
        }),
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
      bookingGuestNight: {
        deleteMany: vi.fn(async () => ({ count: 0 })),
        createMany: vi.fn(async () => ({ count: 0 })),
      },
      choreAssignment: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    },
  };
}

const guestRow = (id: string, firstName: string, lastName: string) => ({
  id,
  firstName,
  lastName,
  ageTier: "ADULT" as const,
  isMember: false,
  memberId: null,
  stayStart: CHECK_IN,
  stayEnd: CHECK_OUT,
  priceCents: 3000,
});

describe("a non-member rename on a modification (#3029 S2)", () => {
  it("clears the note for a different person and keeps it for a typo fix or a named placeholder", async () => {
    const { applyGuestChanges } = await import("@/lib/booking-modify-plan");
    const { tx, updates } = fakeTx();
    const rows = [
      guestRow("swap", "John", "Smith"),
      guestRow("typo", "Jonh", "Smith"),
      guestRow("placeholder", "Guest", "2"),
      guestRow("untouched", "Hana", "Rewi"),
    ];
    const priced = {
      priceCents: 3000,
      perNightCents: [3000],
      perNightPriceSources: ["SOLD" as const],
      nightDates: [CHECK_IN],
    };
    await applyGuestChanges(tx as unknown as Parameters<typeof applyGuestChanges>[0], {
      guestDietarySeeding: bookingGuestDietarySeeding(false),
      bookingId: "bk-1",
      newCheckIn: CHECK_IN,
      newCheckOut: CHECK_OUT,
      removedGuests: [],
      remainingGuests: rows as unknown as Parameters<typeof applyGuestChanges>[1]["remainingGuests"],
      proposedRemainingGuests: rows.map((guest) => ({
        guest,
        stayStart: CHECK_IN,
        stayEnd: CHECK_OUT,
      })) as unknown as Parameters<typeof applyGuestChanges>[1]["proposedRemainingGuests"],
      normalizedAddGuests: undefined,
      guestNameUpdates: [
        { guestId: "swap", firstName: "Mere", lastName: "Walker", previousFirstName: "John", previousLastName: "Smith" },
        { guestId: "typo", firstName: "John", lastName: "Smith", previousFirstName: "Jonh", previousLastName: "Smith" },
        { guestId: "placeholder", firstName: "Tama", lastName: "Ngata", previousFirstName: "Guest", previousLastName: "2" },
      ],
      priceBreakdown: { guests: rows.map(() => priced) },
      inProgressPlan: null,
    });

    const dataFor = (id: string) => updates.find((update) => update.where.id === id)?.data;
    expect(dataFor("swap")).toHaveProperty("dietaryRequirements", null);
    expect(dataFor("typo")).not.toHaveProperty("dietaryRequirements");
    expect(dataFor("placeholder")).not.toHaveProperty("dietaryRequirements");
    expect(dataFor("untouched")).not.toHaveProperty("dietaryRequirements");
  });
});

describe("a row linked to a member on a modification (#3029 W15)", () => {
  it("replaces a named non-member's note with the linked member's profile and only fills an empty placeholder", async () => {
    const { applyGuestChanges } = await import("@/lib/booking-modify-plan");
    const { tx } = fakeTx();
    const member = {
      findMany: vi.fn(async (args: { where: { id: { in: string[] } } }) =>
        args.where.id.in.map((id) => ({ id, dietaryRequirements: `${id} profile` })),
      ),
    };
    const rows = [guestRow("alice", "Alice", "Smith"), guestRow("placeholder", "Guest", "3")];
    const priced = {
      priceCents: 3000,
      perNightCents: [3000],
      perNightPriceSources: ["SOLD" as const],
      nightDates: [CHECK_IN],
    };
    await applyGuestChanges({ ...tx, member } as unknown as Parameters<typeof applyGuestChanges>[0], {
      guestDietarySeeding: bookingGuestDietarySeeding(true),
      bookingId: "bk-1",
      newCheckIn: CHECK_IN,
      newCheckOut: CHECK_OUT,
      removedGuests: [],
      remainingGuests: rows as unknown as Parameters<typeof applyGuestChanges>[1]["remainingGuests"],
      proposedRemainingGuests: rows.map((guest) => ({
        guest,
        stayStart: CHECK_IN,
        stayEnd: CHECK_OUT,
      })) as unknown as Parameters<typeof applyGuestChanges>[1]["proposedRemainingGuests"],
      normalizedAddGuests: undefined,
      guestMemberLinks: new Map([
        ["alice", { memberId: "m-bob", firstName: "Bob", lastName: "Jones" }],
        ["placeholder", { memberId: "m-hana", firstName: "Hana", lastName: "Rewi" }],
      ]),
      priceBreakdown: { guests: rows.map(() => priced) },
      inProgressPlan: null,
    });

    expect(tx.bookingGuest.updateMany).toHaveBeenCalledWith({
      where: { id: "alice", memberId: "m-bob" },
      data: { dietaryRequirements: "m-bob profile" },
    });
    expect(tx.bookingGuest.updateMany).toHaveBeenCalledWith({
      where: { id: "placeholder", memberId: "m-hana", dietaryRequirements: null },
      data: { dietaryRequirements: "m-hana profile" },
    });
    expect(tx.bookingGuest.updateMany).toHaveBeenCalledTimes(2);
  });
});
