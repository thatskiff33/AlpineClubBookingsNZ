import { afterEach, describe, expect, it, vi } from "vitest";

// Follow-up to #1262 (epic #1256): the configurable hut-leader label must flow
// into user-facing prose, not just titles. Override CLUB_HUT_LEADER_LABEL with a
// custom value and prove it reaches server-rendered surfaces at runtime.
vi.mock("@/config/club-identity", async (importActual) => {
  const actual =
    (await importActual()) as typeof import("@/config/club-identity");
  return { ...actual, CLUB_HUT_LEADER_LABEL: "Warden" };
});

vi.mock("@/lib/email/core", () => ({
  sendEmail: vi.fn().mockResolvedValue(undefined),
}));

import { CLUB_HUT_LEADER_LABEL } from "@/config/club-identity";
import { sendEmail } from "@/lib/email/core";
import { hutLeaderAssignmentTemplate } from "@/lib/email-templates/chores";
import { sendHutLeaderAssignmentEmail } from "../email/chores";

const mockedSendEmail = vi.mocked(sendEmail);

afterEach(() => {
  mockedSendEmail.mockClear();
});

describe("hut-leader label flows into prose surfaces (#1262 follow-up)", () => {
  it("uses the custom label in the assignment email body", () => {
    // Guard: the mock is actually in effect.
    expect(CLUB_HUT_LEADER_LABEL).toBe("Warden");

    const html = hutLeaderAssignmentTemplate({
      firstName: "Alice",
      startDate: new Date("2026-07-15"),
      endDate: new Date("2026-07-18"),
      pin: "123456",
      assignmentId: "assign-abc123",
    });

    // Heading is standalone/title-case; body prose is mid-sentence lowercase.
    expect(html).toContain("Warden Assignment");
    expect(html).toContain("taking on warden duties");
    expect(html).toContain("unlock warden controls");
    expect(html).toContain("assigned warden team");
    // The old hard-coded literal must be gone.
    expect(html).not.toContain("hut leader");
  });

  it("keeps the assignment email subject in natural mid-sentence casing", async () => {
    await sendHutLeaderAssignmentEmail({
      email: "alice@example.org",
      firstName: "Alice",
      startDate: new Date("2026-07-15"),
      endDate: new Date("2026-07-18"),
      pin: "123456",
      assignmentId: "assign-abc123",
    });

    expect(mockedSendEmail).toHaveBeenCalledTimes(1);
    const subject = mockedSendEmail.mock.calls[0][0].subject;
    expect(subject).toContain("warden assignment");
    // Not the title-cased drift the follow-up removes.
    expect(subject).not.toContain("Warden assignment");
  });
});
