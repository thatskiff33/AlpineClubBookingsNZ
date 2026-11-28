// @vitest-environment jsdom
import { writeFileSync } from "node:fs";
import { it, vi } from "vitest";

vi.mock("@/components/confirm-its-you", () => ({
  fetchWithRecentAuth: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

import { BookingImportPlanView } from "@/components/admin/booking-import/booking-import-plan-view";
import { BookingImportBatchDetail } from "@/components/admin/booking-import/booking-import-batch-detail";
import { BookingImportBatchesCard } from "@/components/admin/booking-import/booking-import-batches-card";
import { render, screen } from "@/lib/__tests__/support/club-time-render";

const T = (b: number, g: number, n: number, a: number) => ({ bookings: b, guests: g, guestNights: n, amountCents: a });
const nights = (["2026-08-14", "2026-08-15", "2026-08-16"] as const).map((night, i) => ({
  night, capacity: 30, heldBeds: 22, projectedBeds: [30, 29, 26][i]!, importBeds: [8, 7, 4][i]!, refusedBeds: [1, 0, 0][i]!, wholeLodgeHeld: false,
}));
const plan = {
  lodgeId: "l", batchKey: "k", digest: "d",
  rows: [
    { bookingRef: "WB-1041", firstLineNumber: 2, outcome: "IMPORT", alreadyImported: false, refusals: [], checkIn: "2026-08-14", checkOut: "2026-08-17", amountCents: 54_000, guestCount: 4, guestNightCount: 12, appRateCents: 57_600, appRateDifferenceCents: -3_600, nights: [], overCapacityNights: [] },
    { bookingRef: "WB-1042", firstLineNumber: 6, outcome: "IMPORT", alreadyImported: false, refusals: [], checkIn: "2026-08-14", checkOut: "2026-08-16", amountCents: 24_000, guestCount: 4, guestNightCount: 8, appRateCents: 24_000, appRateDifferenceCents: 0, nights: [], overCapacityNights: [] },
    { bookingRef: "WB-1043", firstLineNumber: 10, outcome: "REFUSED", alreadyImported: false, refusals: [{ code: "OVER_CAPACITY", message: "14 Aug 2026 would have 31 people in a 30-bed lodge" }], checkIn: "2026-08-14", checkOut: "2026-08-15", amountCents: 6_000, guestCount: 1, guestNightCount: 1, appRateCents: 6_000, appRateDifferenceCents: 0, nights: [], overCapacityNights: ["2026-08-14"] },
    { bookingRef: "WB-1044", firstLineNumber: 11, outcome: "REFUSED", alreadyImported: false, refusals: [{ code: "HOSTING", message: "The non-members have no adult member hosting them on 15 Aug 2026; enter this booking through Book on Behalf" }], checkIn: "2026-08-15", checkOut: "2026-08-16", amountCents: 9_000, guestCount: 2, guestNightCount: 2, appRateCents: null, appRateDifferenceCents: null, nights: [], overCapacityNights: [] },
  ],
  importTotals: T(2, 8, 20, 78_000), refusedTotals: T(2, 3, 3, 15_000),
  refusedByCode: { OVER_CAPACITY: T(1, 1, 1, 6_000), HOSTING: T(1, 2, 2, 9_000) },
  nights, overFullNights: [{ night: "2026-08-14", fitted: ["WB-1041", "WB-1042"], refused: ["WB-1043"] }],
};
const summary = {
  id: "batch-1", lodgeId: "l", lodgeName: "Ruapehu Lodge", status: "COMPLETED", confirmedAt: "2026-06-30T22:00:00.000Z", confirmedByName: "Oli Officer",
  completedAt: "2026-06-30T22:01:00.000Z", reversedAt: null, reversedByName: null,
  file: T(4, 11, 23, 93_000), imported: T(2, 8, 20, 78_000), refused: T(2, 3, 3, 15_000), reversed: T(0, 0, 0, 0), pending: 0,
};
const detail = {
  batch: summary,
  reversal: {
    batchId: "batch-1", lodgeId: "l", status: "COMPLETED",
    rows: [
      { bookingRef: "WB-1041", firstLineNumber: 2, bookingId: "b1", state: "UNTOUCHED", reasons: [], refusals: [], cancelPending: false, amountCents: 54_000, guestCount: 4, guestNightCount: 12 },
      { bookingRef: "WB-1042", firstLineNumber: 6, bookingId: "b2", state: "TOUCHED", reasons: ["It has been edited since the import"], refusals: [], cancelPending: false, amountCents: 24_000, guestCount: 4, guestNightCount: 8 },
      { bookingRef: "WB-1043", firstLineNumber: 10, bookingId: null, state: "NOT_IMPORTED", reasons: [], refusals: ["14 Aug 2026 would have 31 people in a 30-bed lodge"], cancelPending: false, amountCents: 6_000, guestCount: 1, guestNightCount: 1 },
      { bookingRef: "WB-1044", firstLineNumber: 11, bookingId: null, state: "NOT_IMPORTED", reasons: [], refusals: ["The non-members have no adult member hosting them on 15 Aug 2026; enter this booking through Book on Behalf"], cancelPending: false, amountCents: 9_000, guestCount: 2, guestNightCount: 2 },
    ],
    totals: { UNTOUCHED: T(1, 4, 12, 54_000), TOUCHED: T(1, 4, 8, 24_000), REVERSED: T(0, 0, 0, 0), NOT_IMPORTED: T(2, 3, 3, 15_000) },
  },
};

it("captures", async () => {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const body = url.endsWith("/batches") ? { batches: [summary, { ...summary, id: "b0", status: "REVERSED", confirmedAt: "2026-06-29T03:00:00.000Z", reversedAt: "2026-06-29T04:00:00.000Z", imported: T(0, 0, 0, 0), reversed: T(2, 8, 20, 78_000) }] } : detail;
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
  const a = render(<div className="max-w-5xl p-6"><h2 className="mb-4 text-lg font-semibold">Import paid bookings — preview</h2><BookingImportPlanView plan={plan as never} /></div>);
  writeFileSync("/tmp/scratch/capture/preview.html", a.container.innerHTML);
  a.unmount();
  const b = render(<div className="max-w-5xl space-y-6 p-6"><h1 className="text-3xl font-semibold">Import Paid Bookings</h1><BookingImportBatchesCard canImport /></div>);
  await screen.findByText("Ruapehu Lodge", {}, { timeout: 3000 }).catch(() => null);
  await new Promise((r) => setTimeout(r, 200));
  writeFileSync("/tmp/scratch/capture/list.html", b.container.innerHTML);
  b.unmount();
  const c = render(<div className="max-w-5xl space-y-6 p-6"><h1 className="text-3xl font-semibold">Import Batch</h1><BookingImportBatchDetail batchId="batch-1" canReverse /></div>);
  await screen.findByText("It has been edited since the import");
  writeFileSync("/tmp/scratch/capture/batch.html", c.container.innerHTML);
});
