// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import {
  clearWizardWork,
  loadWizardWork,
  reconcileRestoredWork,
  saveWizardWork,
  type SavedWizardWork,
} from "@/lib/booking-wizard-work";
import { parseCalendarDate, type CalendarDate } from "@/lib/club-time";

const STORAGE_KEY = "booking-wizard-work";
const TODAY = parseCalendarDate("2026-07-01") as CalendarDate;

function work(overrides: Partial<SavedWizardWork> = {}): SavedWizardWork {
  return {
    memberId: "member-1",
    lodgeId: "lodge-a",
    checkIn: "2026-08-01",
    checkOut: "2026-08-03",
    step: "review",
    guests: [
      { firstName: "Jo", lastName: "Member", ageTier: "ADULT", isMember: true, memberId: "member-1" },
      {
        firstName: "Sam",
        lastName: "Friend",
        ageTier: "CHILD",
        isMember: false,
        stayStart: "2026-08-01",
        stayEnd: "2026-08-02",
      },
    ],
    notes: "",
    perGuestDatesEnabled: true,
    multiDateRangesEnabled: false,
    expectedArrivalTime: "18:00",
    requestedRoomId: null,
    cancelIfGuestsBumped: true,
    groupTrip: false,
    groupPaymentMode: "EACH_PAYS_OWN",
    paymentMethod: "internet_banking",
    memberReviewJustification: "",
    useCredit: false,
    attendingWorkParty: false,
    selectedWorkPartyEventId: null,
    waitlistAlternateLodgeIds: [],
    ...overrides,
  };
}

afterEach(() => window.sessionStorage.clear());

describe("booking wizard work storage (#4950)", () => {
  it("round-trips through sessionStorage and never localStorage", () => {
    saveWizardWork(work());
    expect(loadWizardWork("member-1")).toEqual(work());
    expect(window.localStorage.length).toBe(0);
  });

  it("keeps only the whitelisted guest fields", () => {
    const guest = { ...work().guests[1], dateOfBirth: "2018-01-01", passport: "X" };
    saveWizardWork(work({ guests: [guest] }));
    const raw = window.sessionStorage.getItem(STORAGE_KEY) ?? "";
    expect(raw).not.toContain("dateOfBirth");
    expect(raw).not.toContain("passport");
  });

  it("removes a copy for another member, with another version, or unreadable", () => {
    saveWizardWork(work());
    expect(loadWizardWork("member-2")).toBeNull();
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();

    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ ...work(), version: 2 }));
    expect(loadWizardWork("member-1")).toBeNull();
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();

    window.sessionStorage.setItem(STORAGE_KEY, "{not json");
    expect(loadWizardWork("member-1")).toBeNull();
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("rejects a malformed date or a step the wizard cannot resume", () => {
    saveWizardWork(work({ checkIn: "2026-02-30" }));
    expect(loadWizardWork("member-1")).toBeNull();
    saveWizardWork(work({ step: "pay" as SavedWizardWork["step"] }));
    expect(loadWizardWork("member-1")).toBeNull();
  });

  it("clears", () => {
    saveWizardWork(work());
    clearWizardWork();
    expect(loadWizardWork("member-1")).toBeNull();
  });
});

describe("reconcileRestoredWork (#4950)", () => {
  const context = { bookableLodgeIds: ["lodge-a"], today: TODAY };

  it("keeps work whose lodge and dates still stand", () => {
    expect(reconcileRestoredWork(work(), context)).toEqual(work());
  });

  it("keeps a stay starting today", () => {
    const today = work({ checkIn: "2026-07-01", checkOut: "2026-07-02" });
    expect(reconcileRestoredWork(today, context)).toEqual(today);
  });

  it("discards everything when the lodge is no longer bookable", () => {
    expect(reconcileRestoredWork(work({ lodgeId: "lodge-b" }), context)).toBeNull();
  });

  it.each([
    ["past", "2026-06-30", "2026-07-02"],
    ["reversed", "2026-08-03", "2026-08-01"],
    ["empty", "2026-08-01", "2026-08-01"],
  ])("drops %s dates and what hangs off them, keeping the party", (_label, checkIn, checkOut) => {
    const restored = reconcileRestoredWork(work({ checkIn, checkOut }), context);
    expect(restored).toMatchObject({
      checkIn: null,
      checkOut: null,
      step: "dates",
      perGuestDatesEnabled: false,
      multiDateRangesEnabled: false,
      expectedArrivalTime: "18:00",
    });
    expect(restored?.guests).toEqual([
      work().guests[0],
      { firstName: "Sam", lastName: "Friend", ageTier: "CHILD", isMember: false },
    ]);
  });
});
