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

/**
 * Whether a source file reaches next-auth's `signOut` by any door: a named or
 * aliased import, a namespace import, a re-export, a dynamic import or a
 * `require`. Importing something else from the package (`useSession`) is fine.
 */
function reachesNextAuthSignOut(source: string): boolean {
  const pkg = String.raw`["']next-auth\/react["']`;
  const namedOrNamespace = new RegExp(
    String.raw`import\s+(?:type\s+)?(?:(\{[^}]*\}|\*\s*as\s+\w+)|\w+\s*,\s*(\{[^}]*\}|\*\s*as\s+\w+))\s*from\s*${pkg}`,
    "g",
  );
  for (const match of source.matchAll(namedOrNamespace)) {
    const clause = match[1] ?? match[2] ?? "";
    if (clause.startsWith("*") || /\bsignOut\b/.test(clause)) return true;
  }
  return (
    new RegExp(String.raw`export\s+(?:type\s+)?(?:\*|\{[^}]*\})(?:\s+as\s+\w+)?\s*from\s*${pkg}`).test(source) ||
    new RegExp(String.raw`(?:import|require)\(\s*${pkg}\s*\)`).test(source)
  );
}

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
      memberReviewJustification: "",
      useCredit: false,
      attendingWorkParty: false,
      selectedWorkPartyEventId: null,
      waitlistAlternateLodgeIds: [],
      selfSeedSettled: true,
    });
    expect(loadWizardWork("member-1")).not.toBeNull();

    await signOutMember({ callbackUrl: "/login" });

    expect(loadWizardWork("member-1")).toBeNull();
    expect(nextAuth.signOut).toHaveBeenCalledWith({ callbackUrl: "/login" });
  });

  it("is the only client sign-out: nothing else reaches next-auth's signOut", () => {
    const root = process.cwd();
    const direct = productionSourceFiles(root).filter((file) => {
      if (file === "src/lib/member-sign-out.ts") return false;
      return reachesNextAuthSignOut(readFileSync(join(root, file), "utf8"));
    });
    expect(direct).toEqual([]);
  });

  it.each([
    ['import { signOut } from "next-auth/react";'],
    ['import { useSession, signOut as leave } from "next-auth/react";'],
    ['import {\n  useSession,\n  signOut,\n} from "next-auth/react";'],
    ['import * as nextAuth from "next-auth/react";'],
    ['import auth, { signOut } from "next-auth/react";'],
    ['export { signOut } from "next-auth/react";'],
    ['export * from "next-auth/react";'],
    ['const { signOut } = await import("next-auth/react");'],
    ['const nextAuth = require("next-auth/react");'],
  ])("the census catches %s", (source) => {
    expect(reachesNextAuthSignOut(source)).toBe(true);
  });

  it.each([
    ['import { useSession } from "next-auth/react";'],
    ['import { SessionProvider, useSession } from "next-auth/react";'],
    ['import type { SignOutParams } from "next-auth/react";'],
    ['import { signOutMember } from "@/lib/member-sign-out";'],
  ])("the census leaves %s alone", (source) => {
    expect(reachesNextAuthSignOut(source)).toBe(false);
  });
});
