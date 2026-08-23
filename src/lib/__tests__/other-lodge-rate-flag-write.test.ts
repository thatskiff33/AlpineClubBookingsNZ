import { describe, expect, it, vi } from "vitest";

/*
  #2978 review — the other-lodge flag WRITE, at the `applyGuestChanges` DB level.

  THE DEFECT THIS PINS. The election fence and the pricing pass answer the same
  question from different inputs: the fence reads the STORED booking rows, while
  pricing reads the PROPOSED rows, which `linkGuestToMember` has already rewritten
  with the member's identity. So a single request that links placeholder G to
  member M *and* ticks G passes the fence (on the stored booking, G is a
  placeholder non-member) while pricing correctly resolves M through their own
  membership type and charges the ordinary member rate. The money was right; the
  stored flag was not. The Guests list then reads "(Other Club Member)" against a
  member of this club, and the stale flag can go live on a later edit if their
  eligibility changes.

  The write now takes its `true` from what pricing actually rated, and its
  `false` unconditionally, so a flag can never claim a re-rate the money did not
  make and a stale flag can always be cleared.
*/

vi.mock("@/lib/prisma", () => ({
  prisma: { booking: { findUnique: vi.fn() } },
}));

const CHECK_IN = new Date("2026-08-10T00:00:00.000Z");
const CHECK_OUT = new Date("2026-08-11T00:00:00.000Z");

function fakeTx() {
  const updates: Array<{ where: unknown; data: Record<string, unknown> }> = [];
  return {
    updates,
    tx: {
      bookingGuest: {
        create: vi.fn(async () => ({
          id: "bg-new",
          stayStart: CHECK_IN,
          stayEnd: CHECK_OUT,
          memberId: null,
        })),
        update: vi.fn(
          async (args: { where: unknown; data: Record<string, unknown> }) => {
            updates.push(args);
            return {};
          },
        ),
        delete: vi.fn(async () => ({})),
      },
      bookingGuestNight: {
        deleteMany: vi.fn(async () => ({ count: 0 })),
        createMany: vi.fn(async () => ({ count: 1 })),
      },
    },
  };
}

/** One existing guest, unflagged on the stored booking. */
const guest = {
  id: "bg-1",
  firstName: "Vic",
  lastName: "Visitor",
  ageTier: "ADULT" as const,
  isMember: false,
  memberId: null,
  stayStart: CHECK_IN,
  stayEnd: CHECK_OUT,
  priceCents: 4800,
};

type ApplyArgs = Parameters<
  typeof import("@/lib/booking-modify-plan").applyGuestChanges
>[1];

async function writeWith(options: {
  storedFlag: boolean;
  flagged: boolean;
  ratedByPricing: boolean;
}) {
  const { applyGuestChanges } = await import("@/lib/booking-modify-plan");
  const { tx, updates } = fakeTx();
  const stored = { ...guest, otherLodgeMember: options.storedFlag };

  await applyGuestChanges(
    tx as unknown as Parameters<typeof applyGuestChanges>[0],
    {
      bookingId: "bk-1",
      newCheckIn: CHECK_IN,
      newCheckOut: CHECK_OUT,
      removedGuests: [],
      remainingGuests: [stored] as unknown as ApplyArgs["remainingGuests"],
      proposedRemainingGuests: [
        { guest: stored, stayStart: CHECK_IN, stayEnd: CHECK_OUT },
      ] as unknown as ApplyArgs["proposedRemainingGuests"],
      normalizedAddGuests: undefined,
      priceBreakdown: {
        totalPriceCents: 2000,
        guests: [
          { priceCents: 2000, perNightCents: [2000], nightDates: [CHECK_IN] },
        ],
      },
      inProgressPlan: null,
      otherLodgeElection: {
        requested: true,
        otherLodgeId: "lodge-partner",
        otherLodgeIdChanged: true,
        flaggedGuestIds: new Set(options.flagged ? ["bg-1"] : []),
        // Their flag changed, which is what makes this row one the write touches.
        repriceGuestIds: new Set(["bg-1"]),
      },
      otherLodgeRatedGuestIds: new Set(
        options.ratedByPricing ? ["bg-1"] : [],
      ),
    },
  );

  const update = updates.find((u) => (u.where as { id?: string }).id === "bg-1");
  expect(update).toBeDefined();
  return update!.data;
}

describe("#2978: the stored other-lodge flag follows the PRICED rate", () => {
  it("stores the tick when pricing rated the guest at the other-lodge rate", async () => {
    const data = await writeWith({
      storedFlag: false,
      flagged: true,
      ratedByPricing: true,
    });

    expect(data.otherLodgeMember).toBe(true);
  });

  it("does NOT store a tick the rate resolver declined", async () => {
    // The election asked for it and pricing did not honour it — the shape a
    // combined link-and-tick request produces. The row must record what was
    // charged, which is the ordinary rate, not what was asked for.
    const data = await writeWith({
      storedFlag: false,
      flagged: true,
      ratedByPricing: false,
    });

    expect(data.otherLodgeMember).toBe(false);
  });

  it("always clears a flag the request unticked, priced or not", async () => {
    // The other direction is unconditional on purpose: gate the clear on pricing
    // and a stale flag could never be removed, which is how a booking becomes
    // uneditable through this control.
    const data = await writeWith({
      storedFlag: true,
      flagged: false,
      ratedByPricing: false,
    });

    expect(data.otherLodgeMember).toBe(false);
  });

  it("leaves the column alone entirely when this request changed nobody's flag", async () => {
    const { applyGuestChanges } = await import("@/lib/booking-modify-plan");
    const { tx, updates } = fakeTx();
    const stored = { ...guest, otherLodgeMember: true };

    await applyGuestChanges(
      tx as unknown as Parameters<typeof applyGuestChanges>[0],
      {
        bookingId: "bk-1",
        newCheckIn: CHECK_IN,
        newCheckOut: CHECK_OUT,
        removedGuests: [],
        remainingGuests: [stored] as unknown as ApplyArgs["remainingGuests"],
        proposedRemainingGuests: [
          { guest: stored, stayStart: CHECK_IN, stayEnd: CHECK_OUT },
        ] as unknown as ApplyArgs["proposedRemainingGuests"],
        normalizedAddGuests: undefined,
        priceBreakdown: {
          totalPriceCents: 2000,
          guests: [
            { priceCents: 2000, perNightCents: [2000], nightDates: [CHECK_IN] },
          ],
        },
        inProgressPlan: null,
        // An ordinary date edit on a booking that already carries the flag:
        // nobody's flag changes, so the column must not be rewritten at all —
        // otherwise an unrelated edit would strip a settled row.
        otherLodgeElection: {
          requested: false,
          otherLodgeId: "lodge-partner",
          otherLodgeIdChanged: false,
          flaggedGuestIds: new Set(["bg-1"]),
          repriceGuestIds: new Set<string>(),
        },
        otherLodgeRatedGuestIds: new Set<string>(),
      },
    );

    const update = updates.find(
      (u) => (u.where as { id?: string }).id === "bg-1",
    );
    expect(update).toBeDefined();
    expect(update!.data).not.toHaveProperty("otherLodgeMember");
  });
});
