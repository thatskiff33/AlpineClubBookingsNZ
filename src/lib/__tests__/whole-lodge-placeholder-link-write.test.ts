import { describe, expect, it, vi } from "vitest";

/*
  #2337 — the placeholder→member link WRITE, at the `applyGuestChanges` DB level.

  The re-rate itself (member identity + cleared locked prices reaching pricing)
  lives on the RECALCULATE path (`inProgressPlan === null`), which is where a
  member whole-lodge link-only edit resolves. This file pins that the recalculate
  write also stamps the member's CANONICAL NAME onto the linked existing row —
  not just `isMember`/`memberId`. Without it the row stays "Guest N" while flagged
  as the member, and because the batch service treats the identity as changed, the
  post-commit Xero name-sync would push the stale "Guest N" placeholder onto the
  invoice. The in-progress branch already writes the name; this pins the main
  recalculate loop to the same behaviour.

  Revert the `link.firstName && link.lastName ? { firstName, lastName } : {}`
  spread in the recalculate loop and the first assertion fails: the update carries
  the member identity but keeps the placeholder name.
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
        createMany: vi.fn(async () => ({ count: 0 })),
      },
      choreAssignment: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    },
  };
}

describe("#2337: the recalculate write stamps the member's name onto the linked row", () => {
  it("writes firstName/lastName (not just isMember/memberId) so the row shows the member, and the Xero name-sync carries the member name", async () => {
    const { applyGuestChanges } = await import("@/lib/booking-modify-plan");
    const { tx, updates } = fakeTx();

    // The placeholder existing row, still named "Guest 1" in the DB.
    const placeholder = {
      id: "bg-ph1",
      firstName: "Guest",
      lastName: "1",
      ageTier: "ADULT" as const,
      isMember: false,
      memberId: null,
      stayStart: CHECK_IN,
      stayEnd: CHECK_OUT,
      priceCents: 5000,
    };

    await applyGuestChanges(
      tx as unknown as Parameters<typeof applyGuestChanges>[0],
      {
        bookingId: "bk-1",
        newCheckIn: CHECK_IN,
        newCheckOut: CHECK_OUT,
        removedGuests: [],
        remainingGuests: [
          placeholder,
        ] as unknown as Parameters<typeof applyGuestChanges>[1]["remainingGuests"],
        proposedRemainingGuests: [
          { guest: placeholder, stayStart: CHECK_IN, stayEnd: CHECK_OUT },
        ] as unknown as Parameters<
          typeof applyGuestChanges
        >[1]["proposedRemainingGuests"],
        normalizedAddGuests: undefined,
        // The resolved link: member identity AND the member's canonical name, as
        // `modifyBookingBatch` builds it from `guestMemberLinkNames`.
        guestMemberLinks: new Map([
          [
            "bg-ph1",
            { memberId: "member-9", firstName: "Ada", lastName: "Lovelace" },
          ],
        ]),
        priceBreakdown: {
          guests: [
            {
              priceCents: 3000,
              perNightCents: [3000],
              nightDates: [CHECK_IN],
            },
          ],
        },
        // The RECALCULATE path — this is where a link-only member whole-lodge
        // edit resolves (the re-rate reads guestsForPricing, not this plan).
        inProgressPlan: null,
      },
    );

    const phUpdates = updates.filter(
      (u) => (u.where as { id?: string }).id === "bg-ph1",
    );
    expect(phUpdates.length).toBeGreaterThan(0);
    const linkUpdate = phUpdates.find((u) => u.data.memberId === "member-9");
    expect(linkUpdate).toBeDefined();
    // The member identity is stamped…
    expect(linkUpdate?.data.isMember).toBe(true);
    expect(linkUpdate?.data.memberId).toBe("member-9");
    // …AND the member's canonical name — this is the mutation-verify anchor. The
    // DB row the post-commit Xero name-sync reads now carries "Ada Lovelace", not
    // the "Guest 1" placeholder.
    expect(linkUpdate?.data.firstName).toBe("Ada");
    expect(linkUpdate?.data.lastName).toBe("Lovelace");
  });

  it("keeps the placeholder name when the member record carries no name (never blanks the row)", async () => {
    const { applyGuestChanges } = await import("@/lib/booking-modify-plan");
    const { tx, updates } = fakeTx();

    const placeholder = {
      id: "bg-ph2",
      firstName: "Guest",
      lastName: "2",
      ageTier: "ADULT" as const,
      isMember: false,
      memberId: null,
      stayStart: CHECK_IN,
      stayEnd: CHECK_OUT,
      priceCents: 5000,
    };

    await applyGuestChanges(
      tx as unknown as Parameters<typeof applyGuestChanges>[0],
      {
        bookingId: "bk-1",
        newCheckIn: CHECK_IN,
        newCheckOut: CHECK_OUT,
        removedGuests: [],
        remainingGuests: [
          placeholder,
        ] as unknown as Parameters<typeof applyGuestChanges>[1]["remainingGuests"],
        proposedRemainingGuests: [
          { guest: placeholder, stayStart: CHECK_IN, stayEnd: CHECK_OUT },
        ] as unknown as Parameters<
          typeof applyGuestChanges
        >[1]["proposedRemainingGuests"],
        normalizedAddGuests: undefined,
        // A member record with no stored name — the write must NOT blank the row.
        guestMemberLinks: new Map([
          ["bg-ph2", { memberId: "member-x", firstName: null, lastName: null }],
        ]),
        priceBreakdown: {
          guests: [
            { priceCents: 3000, perNightCents: [3000], nightDates: [CHECK_IN] },
          ],
        },
        inProgressPlan: null,
      },
    );

    const linkUpdate = updates.find(
      (u) => (u.where as { id?: string }).id === "bg-ph2",
    );
    expect(linkUpdate?.data.isMember).toBe(true);
    expect(linkUpdate?.data.memberId).toBe("member-x");
    // No name overwrite is issued, so the stored placeholder name survives.
    expect(linkUpdate?.data).not.toHaveProperty("firstName");
    expect(linkUpdate?.data).not.toHaveProperty("lastName");
  });
});
