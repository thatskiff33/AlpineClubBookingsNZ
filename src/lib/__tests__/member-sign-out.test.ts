// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { productionSourceFiles } from "./support/prisma-delegate-read-scan";

const nextAuth = vi.hoisted(() => ({ signOut: vi.fn(async () => undefined) }));
vi.mock("next-auth/react", () => nextAuth);

import { loadWizardWork, saveWizardWork } from "@/lib/booking-wizard-work";
import { signOutMember } from "@/lib/member-sign-out";

afterEach(() => {
  window.sessionStorage.clear();
  vi.clearAllMocks();
});

describe("signing out forgets the booking wizard's kept work (#4950)", () => {
  it("clears the kept work, then signs out with the caller's options", async () => {
    saveWizardWork({
      memberId: "member-1",
      lodgeId: "lodge-a",
      checkIn: "2026-08-01",
      checkOut: "2026-08-03",
      step: "guests",
      guests: [{ firstName: "Sam", lastName: "Friend", ageTier: "ADULT", isMember: false }],
      notes: "",
      perGuestDatesEnabled: false,
      multiDateRangesEnabled: false,
      expectedArrivalTime: null,
      requestedRoomId: null,
      cancelIfGuestsBumped: false,
      groupTrip: false,
      groupPaymentMode: "EACH_PAYS_OWN",
      paymentMethod: "stripe",
      memberReviewJustification: "",
    useCredit: false,
    attendingWorkParty: false,
    selectedWorkPartyEventId: null,
    waitlistAlternateLodgeIds: [],
    });
    expect(loadWizardWork("member-1")).not.toBeNull();

    await signOutMember({ callbackUrl: "/login" });

    expect(loadWizardWork("member-1")).toBeNull();
    expect(nextAuth.signOut).toHaveBeenCalledWith({ callbackUrl: "/login" });
  });

  it("is the only client sign-out: nothing else imports next-auth's signOut", () => {
    const root = process.cwd();
    const direct = productionSourceFiles(root).filter((file) => {
      if (file === "src/lib/member-sign-out.ts") return false;
      const source = readFileSync(join(root, file), "utf8");
      return /import\s*\{[^}]*\bsignOut\b[^}]*\}\s*from\s*["']next-auth\/react["']/.test(
        source,
      );
    });
    expect(direct).toEqual([]);
  });
});
