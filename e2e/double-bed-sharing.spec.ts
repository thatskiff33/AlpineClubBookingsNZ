import {
  type APIResponse,
  type BrowserContext,
  expect,
  test,
} from "@playwright/test";
import { storageStatePath } from "./helpers/auth";
import {
  overrideSingleLodgeAutoAllocation,
  setBedAllocationSettings,
  type BedAllocationSettingsSnapshot,
} from "./helpers/bed-allocation-settings";
import {
  bookingCreateIsolation,
  postBookingCreate,
} from "./helpers/booking-create-client-ip";
import {
  DEMO_BOOKING_WINDOWS,
  E2E_ADMIN,
  relDateOnly,
  shiftDateOnly,
} from "./helpers/fixtures";
import { overrideModules, setModuleSettings, type ModuleSettings } from "./helpers/modules";

// docs/END_TO_END_TEST_MATRIX.md rows "Partner relationship (#1742)" and
// "Partner-shared double-bed capacity (#1745/#1746)". Epic #1741 "Double-bed
// shared occupancy": a CONFIRMED partner may be admitted onto a booking as the
// second occupant of a shared DOUBLE bed, consuming a reserved capacity slot
// (one per active double) rather than an ordinary bed. Initiation is
// ADMIN-ONLY (#1746) — self-serve partner initiation did NOT ship, so this spec
// has no member-driven variant by design.
//
// Fixtures are built in-spec via the admin API with capture-then-restore (no
// demo-seed edits):
//   - A CONFIRMED partner link Carol⇄Dave and Erin⇄Frank (admin partner-link
//     POST; deleted in afterAll). The seed ships no partner links.
//   - One SINGLE bed is retyped to DOUBLE (beds PATCH; restored in afterAll) so
//     the lodge has partner-shared headroom and a shareable double to place on.
//   - S1 and S3 read the SEEDED bookings bPayPending (Carol, PAYMENT_PENDING,
//     future + modifiable) and bCompleted (Heidi, COMPLETED, past), whose nights
//     are RELATIVE fixtures (issue #2117: a fixed future date here crossing the
//     NZ in-progress boundary was the original CI-red root cause), resolved by
//     member name off the bed-allocation board over the shared fixture window —
//     S1 cancels its panel and S3 only previews, so they persist nothing.
//   - S2 and S4 build their own FUTURE, CONFIRMED (capacity-holding) bookings on
//     runtime-derived empty in-season windows (deriveHoldingWindows): the
//     second-occupant rule and the base-full check both need capacity-holding
//     bookings, and a fully-past booking cannot take a guest addition. Internet
//     Banking with holdBedSlots on lands a CONFIRMED
//     booking without Stripe — the IB + Xero modules and the holdBedSlots
//     setting are toggled on in beforeAll (Xero stays unconfigured, so the
//     queued invoice is never sent) and all are restored in afterAll. Those
//     CONFIRMED bookings are CANCELLED in teardown (only DRAFTs hard-delete),
//     which frees their held beds.
//
// S2 proves the reserved-slot RAISE for real, not a false positive. The per-
// booking cap in modify-quote/modify (`totalGuestCount > getLodgeCapacity`)
// fires BEFORE the partner-shared branch and reads the BASE capacity, so a
// booking cannot exceed the base on its own guests — the fullness must come from
// OTHER capacity-holding bookings on the anchor's nights, or the partner would
// simply take a free base bed (proving nothing). So S2 builds a dedicated,
// empty FUTURE window that it fills to exactly the base: a capacity-holding
// filler of (base−1) non-member guests plus a 1-guest anchor for Carol (both
// CONFIRMED via IB + holdBedSlots — the S4 pattern). On that genuinely-full
// window an ordinary extra guest is refused while Carol's confirmed partner is
// admitted, and removing the double (headroom → 0) then refuses the same partner
// — the reserved slot, bounded by the double count, is exactly what raised
// capacity. The base is read live so the filler sizes itself.
test.describe.configure({ mode: "serial" });

const DEMO_DOMAIN = "demo.alpineclub.test";
const demoEmail = (local: string) => `${local}@${DEMO_DOMAIN}`;

// Windows for the created holding bookings, DERIVED AT RUNTIME (not hardcoded)
// in beforeAll from a future, in-season, unoccupied stretch of nights — see
// deriveHoldingWindows(). They must be future (a past booking cannot take a
// guest addition) and in an open season (else pricing has no rate), so pinning
// absolute dates would rot the *required* Playwright E2E check to red at a fixed
// calendar instant. S2 fills its window to exactly the base capacity; S4 keeps
// its own disjoint window so S2's still-live filler never crowds it.
type Window = { checkIn: string; checkOut: string; night: string };
let S2_WINDOW: Window;
let S4_WINDOW: Window;

let adminContext: BrowserContext;
let bedAllocationSettingsBefore: BedAllocationSettingsSnapshot | undefined;

// Captured-for-restore state (afterAll runs defensively over all of it).
let doubleBedId = "";
let doubleBedOriginalType = "SINGLE";
let modulesBefore: ModuleSettings | undefined;
let ibSettingsBefore:
  | { holdBedSlots: boolean; holdDays: number; minimumDaysBeforeCheckIn: number }
  | undefined;
const createdBookingIds: string[] = [];
const createdLinks: Array<{ memberId: string; linkId: string }> = [];
type CreatedAllocation = {
  allocationId: string;
  bookingId: string;
  bookingGuestId: string;
  lodgeId: string;
  stayDate: string;
};
const createdAllocations: CreatedAllocation[] = [];

type Member = { id: string; firstName: string; lastName: string; email: string };
const members: Record<string, Member> = {};

let carolBookingId = "";
let heidiBookingId = "";

function api() {
  return adminContext.request;
}

async function resolveMember(local: string): Promise<Member> {
  const res = await api().get(
    `/api/admin/members?q=${encodeURIComponent(local)}&pageSize=100`,
  );
  expect(res.ok(), `GET members ?q=${local} (${res.status()})`).toBeTruthy();
  const body = await res.json();
  const want = demoEmail(local);
  const match = body.members.find((m: Member) => m.email === want);
  expect(match, `seeded member ${want} not found`).toBeTruthy();
  return match as Member;
}

async function createPartnerLink(memberId: string, partnerMemberId: string) {
  const res = await api().post(`/api/admin/members/${memberId}/partner-link`, {
    data: { partnerMemberId },
  });
  expect(
    res.ok(),
    `create partner link (${res.status()}): ${await res.text()}`,
  ).toBeTruthy();
  const body = await res.json();
  createdLinks.push({ memberId, linkId: body.linkId });
}

async function getRoomsConfig() {
  const res = await api().get("/api/admin/bed-allocation/rooms");
  expect(res.ok(), `GET rooms config (${res.status()})`).toBeTruthy();
  return await res.json();
}

async function setBedType(bedId: string, bedType: "SINGLE" | "DOUBLE") {
  const res = await api().patch(`/api/admin/bed-allocation/beds/${bedId}`, {
    data: { bedType },
  });
  expect(
    res.ok(),
    `set bed ${bedId} type ${bedType} (${res.status()}): ${await res.text()}`,
  ).toBeTruthy();
}

async function getBoard(from: string, to: string, bookingId?: string) {
  const query = new URLSearchParams({ from, to });
  if (bookingId) query.set("bookingId", bookingId);
  const res = await api().get(`/api/admin/bed-allocation?${query.toString()}`);
  expect(res.ok(), `GET board ${from}..${to} (${res.status()})`).toBeTruthy();
  return await res.json();
}

async function resolveBookingIdByMember(
  memberName: string,
  from: string,
  to: string,
): Promise<string> {
  const board = await getBoard(from, to);
  const booking = board.bookings.find(
    (b: { memberName: string }) => b.memberName === memberName,
  );
  expect(booking, `no board booking for ${memberName} in ${from}..${to}`).toBeTruthy();
  return booking.id as string;
}

async function modifyQuote(bookingId: string, body: unknown) {
  return api().post(`/api/bookings/${bookingId}/modify-quote`, { data: body });
}

async function modifyApply(bookingId: string, body: unknown) {
  return api().put(`/api/bookings/${bookingId}/modify`, { data: body });
}

async function allocate(bookingGuestId: string, bedId: string, stayDate: string) {
  const res = await api().post("/api/admin/bed-allocation/allocations", {
    data: { bookingGuestId, bedId, stayDate },
  });
  expect(
    res.ok(),
    `allocate ${bookingGuestId} -> ${bedId} @ ${stayDate} (${res.status()}): ${await res.text()}`,
  ).toBeTruthy();
  const body = await res.json();
  const board = await getBoard(stayDate, shiftDateOnly(stayDate, 1));
  const booking = board.bookings.find(
    (candidate: { id: string }) => candidate.id === body.allocation.bookingId,
  );
  expect(
    booking,
    `allocation booking ${body.allocation.bookingId} missing from board`,
  ).toBeTruthy();
  createdAllocations.push({
    allocationId: body.allocation.id,
    bookingId: body.allocation.bookingId,
    bookingGuestId: body.allocation.bookingGuestId,
    lodgeId: bedAllocationSettingsBefore!.lodgeId,
    stayDate,
  });
  return body.allocation as {
    id: string;
    bookingGuestId: string;
    bedId: string;
    stayDate: string;
    isSecondOccupant: boolean;
  };
}

async function deleteAllocation(id: string) {
  const anchor = createdAllocations.find(
    (allocation) => allocation.allocationId === id,
  );
  expect(anchor, `tracked allocation anchor ${id} missing`).toBeTruthy();
  const scope = { type: "ALLOCATION", ...anchor };
  const preview = await api().post(
    "/api/admin/bed-allocation/allocations/removal",
    { data: { scope, categories: ["MANUAL_DRAFT"] } },
  );
  const previewBody = await preview.text();
  expect(
    preview.ok(),
    `preview allocation removal ${id} (${preview.status()}): ${previewBody}`,
  ).toBeTruthy();
  const reviewed = JSON.parse(previewBody);
  const apply = await api().put(
    "/api/admin/bed-allocation/allocations/removal",
    {
      data: {
        scope,
        categories: ["MANUAL_DRAFT"],
        previewDigest: reviewed.digest,
      },
    },
  );
  expect(
    apply.ok(),
    `apply allocation removal ${id} (${apply.status()})`,
  ).toBeTruthy();
  const index = createdAllocations.findIndex(
    (allocation) => allocation.allocationId === id,
  );
  if (index >= 0) createdAllocations.splice(index, 1);
}

function memberGuest(member: Member) {
  return {
    firstName: member.firstName,
    lastName: member.lastName,
    ageTier: "ADULT" as const,
    isMember: true,
    memberId: member.id,
  };
}

function nonMemberGuest(i: number) {
  return {
    firstName: "Filler",
    lastName: `S2Guest${i}`,
    ageTier: "ADULT" as const,
    isMember: false,
  };
}

// Create a CONFIRMED (capacity-holding) booking via Internet Banking with
// holdBedSlots on — no Stripe. Tracked for teardown. Enabled once in beforeAll.
function holdingBookingOptions(opts: {
  forMemberId: string;
  guests: ReturnType<typeof memberGuest | typeof nonMemberGuest>[];
  window: { checkIn: string; checkOut: string };
}) {
  return {
    data: {
      checkIn: opts.window.checkIn,
      checkOut: opts.window.checkOut,
      guests: opts.guests,
      forMemberId: opts.forMemberId,
      paymentMethod: "internet_banking",
    },
  };
}

async function recordHoldingBooking(
  res: APIResponse,
): Promise<{ id: string; status: string }> {
  expect(
    res.ok(),
    `create holding booking (${res.status()}): ${await res.text()}`,
  ).toBeTruthy();
  const body = await res.json();
  createdBookingIds.push(body.id);
  expect(
    body.status,
    `holding booking must be CONFIRMED (got ${body.status})`,
  ).toBe("CONFIRMED");
  return body;
}

async function monthAvailability(
  year: number,
  month0: number,
): Promise<{ availability: Record<string, number>; seasons: Record<string, unknown> }> {
  const res = await api().get(`/api/availability?year=${year}&month=${month0}`);
  expect(res.ok(), `availability ${year}-${month0} (${res.status()})`).toBeTruthy();
  return res.json();
}

// Derive S2/S4 windows from a future, in-season, currently-unoccupied run of
// `needed` consecutive nights (the availability API exposes per-night occupancy
// and an in-season `seasons[night]` marker). Runtime-derived so the required
// Playwright check self-adjusts as wall-clock advances instead of rotting red at
// a fixed date; it fails loud only once the seeded seasons are entirely past —
// the whole suite's seed-refresh signal, not a silent flake.
async function deriveHoldingWindows(): Promise<void> {
  const needed = 5; // S2 nights [0,1] + gap [2] + S4 nights [3,4]
  // Future margin, counted from the CLUB's day rather than the runner's UTC one
  // (`prisma/e2e-fixtures.ts` → E2E_TODAY_NZ). A day either way is absorbed by
  // the 14-day margin, so this was never the failing case — it is here so the
  // suite has ONE notion of "today" and nobody copies the old shape.
  const from = relDateOnly(14);
  const nights: Array<{ date: string; ok: boolean }> = [];
  let cursor = new Date(`${from.slice(0, 7)}-01T00:00:00Z`);
  for (let m = 0; m < 12; m += 1) {
    const y = cursor.getUTCFullYear();
    const mo = cursor.getUTCMonth();
    const { availability, seasons } = await monthAvailability(y, mo);
    const days = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
    for (let d = 1; d <= days; d += 1) {
      const date = `${y}-${String(mo + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      if (date < from) continue;
      nights.push({ date, ok: Boolean(seasons[date]) && (availability[date] ?? 0) === 0 });
    }
    cursor = new Date(Date.UTC(y, mo + 1, 1));
  }
  let start = "";
  for (let i = 0; i + needed <= nights.length; i += 1) {
    const run = nights.slice(i, i + needed);
    const contiguous = run.every((f, k) => k === 0 || shiftDateOnly(run[k - 1].date, 1) === f.date);
    if (contiguous && run.every((f) => f.ok)) {
      start = run[0].date;
      break;
    }
  }
  expect(
    start,
    "no future 5-night empty in-season window in the next 12 months — the E2E seed seasons need refreshing forward (prisma/seed.ts)",
  ).toBeTruthy();
  S2_WINDOW = { checkIn: start, checkOut: shiftDateOnly(start, 2), night: start };
  S4_WINDOW = {
    checkIn: shiftDateOnly(start, 3),
    checkOut: shiftDateOnly(start, 5),
    night: shiftDateOnly(start, 3),
  };
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  // Reuse the E2E admin session saved once in auth.setup.ts instead of a fresh
  // per-spec login (#1779). This spec's admin login previously needed a private
  // IP bucket ("10.88.7.47") to avoid tipping the shared E2E_ADMIN login bucket
  // past its ceiling; reusing storageState removes that fragility entirely.
  adminContext = await browser.newContext({
    storageState: storageStatePath(E2E_ADMIN.email),
  });

  // Disable auto-allocation so nothing auto-places a bed under our manual
  // board steps (schema default is true; restored in afterAll).
  bedAllocationSettingsBefore = await overrideSingleLodgeAutoAllocation(
    api(),
    false,
  );

  for (const local of ["carol", "dave", "erin", "frank", "grace", "heidi"]) {
    members[local] = await resolveMember(local);
  }

  await createPartnerLink(members.carol.id, members.dave.id);
  await createPartnerLink(members.erin.id, members.frank.id);

  // Pick future, in-season, capacity-empty windows before choosing the temporary
  // DOUBLE: a non-capacity-holding review booking can still have a manual bed
  // allocation on one of those nights.
  await deriveHoldingWindows();

  // Retype one active SINGLE bed (no bunk group and no allocation in the S4
  // window) to DOUBLE so the lodge gains partner-shared headroom and a placeable
  // shared double.
  const s4Board = await getBoard(S4_WINDOW.checkIn, S4_WINDOW.checkOut);
  const s4AllocatedBedIds = new Set(
    s4Board.allocations.map((allocation: { bedId: string }) => allocation.bedId),
  );
  const config = await getRoomsConfig();
  const candidateBed = config.rooms
    .flatMap((room: { beds: Array<{ id: string; active: boolean; bedType: string; bunkGroup: string | null }> }) => room.beds)
    .find(
      (bed: { id: string; active: boolean; bedType: string; bunkGroup: string | null }) =>
        bed.active &&
        bed.bedType === "SINGLE" &&
        !bed.bunkGroup &&
        !s4AllocatedBedIds.has(bed.id),
    );
  expect(
    candidateBed,
    "no plain active SINGLE bed without an S4-window allocation to retype to DOUBLE",
  ).toBeTruthy();
  expect(
    s4AllocatedBedIds.has(candidateBed.id),
    "the temporary double must be empty throughout the S4 window",
  ).toBe(false);
  doubleBedId = candidateBed.id;
  doubleBedOriginalType = candidateBed.bedType;
  await setBedType(doubleBedId, "DOUBLE");

  // Enable Internet Banking with holdBedSlots so S2 and S4 can create CONFIRMED,
  // capacity-holding bookings without Stripe. Xero is toggled on to gate the IB
  // flow but stays UNCONFIGURED, so the queued invoice is never sent. Both the
  // modules and the IB settings are restored in afterAll.
  modulesBefore = await overrideModules(api(), {
    xeroIntegration: true,
    internetBankingPayments: true,
  });
  const ibGet = await api().get("/api/admin/internet-banking-settings");
  expect(ibGet.ok(), `GET IB settings (${ibGet.status()})`).toBeTruthy();
  ibSettingsBefore = (await ibGet.json()).settings;
  const ibPut = await api().put("/api/admin/internet-banking-settings", {
    data: {
      holdBedSlots: true,
      holdDays: ibSettingsBefore!.holdDays,
      minimumDaysBeforeCheckIn: 0,
    },
  });
  expect(ibPut.ok(), `enable holdBedSlots (${ibPut.status()})`).toBeTruthy();

  // Resolve the seeded bookings S1 and S3 read (by owner name off the board).
  // The board window matches the RELATIVE seeded fixture (issue #2117): Carol's
  // PAYMENT_PENDING booking is future+modifiable, Heidi's COMPLETED booking is
  // past — imported from the shared fixtures so seed and spec never drift.
  carolBookingId = await resolveBookingIdByMember(
    "Carol Clark",
    DEMO_BOOKING_WINDOWS.carolPaymentPending.checkIn,
    DEMO_BOOKING_WINDOWS.carolPaymentPending.checkOut,
  );
  heidiBookingId = await resolveBookingIdByMember(
    "Heidi Hill",
    DEMO_BOOKING_WINDOWS.heidiCompleted.checkIn,
    DEMO_BOOKING_WINDOWS.heidiCompleted.checkOut,
  );
});

test.afterAll(async () => {
  // Defensive restore, tolerating partial setup. Delete allocations and the S4
  // booking BEFORE restoring the bed type: a DOUBLE with a second-occupant row
  // cannot be retyped.
  try {
    for (const allocation of [...createdAllocations]) {
      await deleteAllocation(allocation.allocationId).catch(() => undefined);
    }
    // Holding bookings are CONFIRMED, so they cannot be hard-deleted (only
    // DRAFTs can); cancel them instead — nothing was paid, so the credit-method
    // cancel is a no-op settlement that just frees the held beds.
    for (const id of createdBookingIds) {
      await api()
        .post(`/api/bookings/${id}/cancel`, {
          data: { refundMethod: "credit", notifyMember: false },
        })
        .catch(() => undefined);
    }
    if (doubleBedId) {
      await api()
        .patch(`/api/admin/bed-allocation/beds/${doubleBedId}`, {
          data: { bedType: doubleBedOriginalType },
        })
        .catch(() => undefined);
    }
    if (ibSettingsBefore) {
      await api()
        .put("/api/admin/internet-banking-settings", {
          data: {
            holdBedSlots: ibSettingsBefore.holdBedSlots,
            holdDays: ibSettingsBefore.holdDays,
            minimumDaysBeforeCheckIn: ibSettingsBefore.minimumDaysBeforeCheckIn,
          },
        })
        .catch(() => undefined);
    }
    if (modulesBefore) {
      await setModuleSettings(api(), modulesBefore).catch(() => undefined);
    }
    for (const link of createdLinks) {
      await api()
        .delete(`/api/admin/members/${link.memberId}/partner-link?id=${link.linkId}`)
        .catch(() => undefined);
    }
    if (bedAllocationSettingsBefore) {
      await setBedAllocationSettings(api(), bedAllocationSettingsBefore).catch(
        () => undefined,
      );
    }
  } finally {
    await adminContext?.close();
  }
});

// S1 — the #1746 admin partner quick-add UI (browser). Proves candidate
// computation + panel rendering + add. Persists nothing (panel is cancelled).
test("S1 — admin edit panel offers and adds a confirmed partner (#1746)", async () => {
  const page = await adminContext.newPage();
  try {
    await page.goto(`/bookings/${carolBookingId}`);
    await page.getByRole("button", { name: "Edit Booking" }).click();

    await expect(
      page.getByText("Add a partner (shares a double bed)"),
    ).toBeVisible({ timeout: 30_000 });

    // Rendered label: "+ Dave Davis — partner of Carol Clark".
    const candidate = page.getByRole("button", {
      name: /Dave Davis.*partner of Carol Clark/,
    });
    await expect(candidate).toBeVisible();
    await candidate.click();

    // Adding flips the SAME button into the "✓"/disabled state.
    await expect(candidate).toBeDisabled();

    // S1 never saves: close the panel without persisting the addition.
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByRole("button", { name: "Edit Booking" })).toBeVisible();
  } finally {
    await page.close();
  }
});

// S2 — sharing RAISES capacity, reserved and bounded by the double count
// (#1745). On a window filled to exactly the base, an ordinary guest is refused
// but Carol's confirmed partner is admitted via the reserved double slot; with
// the double removed (headroom → 0) the same partner is refused.
test("S2 — full-by-beds admits an eligible partner via the reserved slot, bounded by the double count (#1745/#1746)", async ({}, testInfo) => {
  const status = (await getRoomsConfig()).capacity;
  const base = status.capacity;
  expect(status.activeDoubleBedCount).toBeGreaterThanOrEqual(1);
  expect(status.partnerSharedHeadroom).toBeGreaterThanOrEqual(1);

  // Fill the window to exactly `base`: a (base−1)-guest non-member filler plus a
  // 1-guest anchor for Carol. The filler carries the fullness so the anchor's
  // own guest count stays ≤ base (the per-booking cap would otherwise reject
  // before the partner-shared branch even runs).
  const fillerGuests = Array.from({ length: base - 1 }, (_, i) => nonMemberGuest(i));
  await recordHoldingBooking(
    await postBookingCreate(
      api(),
      bookingCreateIsolation("double-bed-capacity", testInfo.retry),
      holdingBookingOptions({
        forMemberId: members.grace.id,
        guests: fillerGuests,
        window: S2_WINDOW,
      }),
    ),
  );
  const anchor = await recordHoldingBooking(
    await postBookingCreate(
      api(),
      bookingCreateIsolation("double-bed-capacity", testInfo.retry),
      holdingBookingOptions({
        forMemberId: members.carol.id,
        guests: [memberGuest(members.carol)],
        window: S2_WINDOW,
      }),
    ),
  );

  // The base is genuinely full: an ORDINARY extra guest cannot be admitted (it
  // may never consume the partner-reserved slot).
  const ordinary = await modifyQuote(anchor.id, {
    addGuests: [nonMemberGuest(base)],
  });
  expect(
    ordinary.ok(),
    `S2 ordinary quote (${ordinary.status()}): ${await ordinary.text()}`,
  ).toBeTruthy();
  expect(
    (await ordinary.json()).capacityAvailable,
    "an ordinary guest cannot exceed the full base",
  ).toBe(false);

  // Carol's confirmed partner IS admitted — the reserved double slot raised
  // capacity above the full base.
  const admit = await modifyQuote(anchor.id, {
    addGuests: [memberGuest(members.dave)],
    partnerSharedGuests: [
      { memberId: members.dave.id, partnerMemberId: members.carol.id },
    ],
  });
  expect(
    admit.ok(),
    `S2 admit quote (${admit.status()}): ${await admit.text()}`,
  ).toBeTruthy();
  const admitBody = await admit.json();
  // partnerSharedReason is present ONLY on rejection; absent/null == admitted.
  expect(
    admitBody.partnerSharedReason ?? null,
    "the eligible partner must be admitted (no rejection reason)",
  ).toBeNull();
  expect(
    admitBody.capacityAvailable,
    "the partner is admitted into the reserved slot above the full base",
  ).toBe(true);

  // Bounded by the double count: remove the only double (headroom → 0) and the
  // SAME partner is now refused, proving the admission rode the reserved slot.
  await setBedType(doubleBedId, "SINGLE");
  try {
    const bounded = await modifyQuote(anchor.id, {
      addGuests: [memberGuest(members.dave)],
      partnerSharedGuests: [
        { memberId: members.dave.id, partnerMemberId: members.carol.id },
      ],
    });
    expect(
      bounded.ok(),
      `S2 bounded quote (${bounded.status()}): ${await bounded.text()}`,
    ).toBeTruthy();
    expect(
      (await bounded.json()).capacityAvailable,
      "with no double there is no reserved slot, so the partner is refused",
    ).toBe(false);
  } finally {
    await setBedType(doubleBedId, "DOUBLE");
  }
});

// S3 — eligibility is fail-loud and pairing-based (#1744/#1746): a fabricated
// non-partner pairing is rejected regardless of fullness, and a booking whose
// member has no confirmed partner offers no candidates.
test("S3 — non-partners rejected; partnerless booking offers no candidates (#1744/#1746)", async () => {
  const reject = await modifyQuote(carolBookingId, {
    addGuests: [memberGuest(members.grace)],
    // Grace holds no confirmed link with Carol (or anyone).
    partnerSharedGuests: [
      { memberId: members.grace.id, partnerMemberId: members.carol.id },
    ],
  });
  expect(
    reject.ok(),
    `S3 reject quote (${reject.status()}): ${await reject.text()}`,
  ).toBeTruthy();
  const rejectBody = await reject.json();
  expect(typeof rejectBody.partnerSharedReason).toBe("string");
  expect(rejectBody.partnerSharedReason).toMatch(
    /partner relationship|confirmed partner|active adults/i,
  );
  expect(rejectBody.capacityAvailable).toBe(false);

  // Positive control: Carol (a confirmed partner exists) offers Dave.
  const carolFamily = await api().get(
    `/api/admin/bookings/${carolBookingId}/eligible-family`,
  );
  expect(carolFamily.ok(), `Carol eligible-family (${carolFamily.status()})`).toBeTruthy();
  const carolCandidates = (await carolFamily.json()).partnerSharingCandidates;
  expect(
    carolCandidates.some((c: { id: string }) => c.id === members.dave.id),
    "Carol's confirmed partner Dave must be a sharing candidate",
  ).toBe(true);

  // Heidi holds no partner link, so her booking offers none.
  const heidiFamily = await api().get(
    `/api/admin/bookings/${heidiBookingId}/eligible-family`,
  );
  expect(heidiFamily.ok(), `Heidi eligible-family (${heidiFamily.status()})`).toBeTruthy();
  expect((await heidiFamily.json()).partnerSharingCandidates).toEqual([]);
});

// S4 — board placement of the partner as second occupant on the shared double,
// then orphan auto-promote when the primary allocation is removed (#1701/#1743).
// Runs last: it carries the heaviest setup (module + IB-settings toggles + a
// created holding booking), so a setup failure here never masks S1–S3.
test("S4 — second-occupant placement and orphan auto-promote (#1701/#1743)", async ({}, testInfo) => {
  // The second-occupant rule requires the primary's booking to HOLD capacity, so
  // the anchor is a CONFIRMED future booking for Erin (IB + holdBedSlots, enabled
  // in beforeAll; a fully-past booking cannot take a guest addition).
  const anchor = await recordHoldingBooking(
    await postBookingCreate(
      api(),
      bookingCreateIsolation("double-bed-allocation", testInfo.retry),
      holdingBookingOptions({
        forMemberId: members.erin.id,
        guests: [memberGuest(members.erin)],
        window: S4_WINDOW,
      }),
    ),
  );

  // (i) admit Erin's confirmed partner Frank onto the booking.
  const admit = await modifyApply(anchor.id, {
    addGuests: [memberGuest(members.frank)],
    partnerSharedGuests: [
      { memberId: members.frank.id, partnerMemberId: members.erin.id },
    ],
  });
  expect(
    admit.ok(),
    `admit partner Frank (${admit.status()}): ${await admit.text()}`,
  ).toBeTruthy();

  // (ii) read both guest ids off the board for the shared night.
  const board = await getBoard(S4_WINDOW.checkIn, S4_WINDOW.checkOut, anchor.id);
  const anchorBoard = board.bookings.find(
    (b: { id: string }) => b.id === anchor.id,
  );
  expect(anchorBoard, "S4 anchor missing from the board").toBeTruthy();
  const erinGuest = anchorBoard.guests.find((g: { name: string }) =>
    g.name.includes("Erin"),
  );
  const frankGuest = anchorBoard.guests.find((g: { name: string }) =>
    g.name.includes("Frank"),
  );
  expect(erinGuest, "Erin guest not on the anchor").toBeTruthy();
  expect(frankGuest, "Frank guest not on the anchor").toBeTruthy();

  // (iii) allocate Erin (primary) to the double.
  const primary = await allocate(erinGuest.id, doubleBedId, S4_WINDOW.night);
  expect(primary.isSecondOccupant, "the first occupant is the primary").toBe(false);

  // (iv) allocate Frank to the SAME double + night -> the second occupant.
  const second = await allocate(frankGuest.id, doubleBedId, S4_WINDOW.night);
  expect(
    second.isSecondOccupant,
    "the partner is placed as the shared double's second occupant",
  ).toBe(true);

  // (v) remove the primary -> the stranded second occupant auto-promotes.
  await deleteAllocation(primary.id);

  const after = await getBoard(S4_WINDOW.checkIn, S4_WINDOW.checkOut, anchor.id);
  const nightAllocations = after.allocations.filter(
    (a: { stayDate: string }) => a.stayDate === S4_WINDOW.night,
  );
  const frankAllocation = nightAllocations.find(
    (a: { bookingGuestId: string }) => a.bookingGuestId === frankGuest.id,
  );
  expect(frankAllocation, "the partner allocation must survive the delete").toBeTruthy();
  expect(
    frankAllocation.isSecondOccupant,
    "the partner is promoted to primary (no longer second occupant)",
  ).toBe(false);
  expect(
    nightAllocations.some((a: { isSecondOccupant: boolean }) => a.isSecondOccupant),
    "no lone second occupant may remain on the double",
  ).toBe(false);
});
