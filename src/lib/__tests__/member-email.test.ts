import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks (must be hoisted so they are available when modules are imported)
// ---------------------------------------------------------------------------

const { mockPrisma } = vi.hoisted(() => {
  const mockPrisma = {
    member: {
      findUnique: vi.fn(),
    },
    emailLog: {
      create: vi.fn().mockResolvedValue({ id: "log-1" }),
      update: vi.fn().mockResolvedValue({}),
    },
  };
  return { mockPrisma };
});

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("getEffectiveEmail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns own email when inheritEmailFromId is null", async () => {
    const { getEffectiveEmail } = await import("../member-utils");
    const member = { email: "own@example.com", inheritEmailFromId: null };
    expect(await getEffectiveEmail(member)).toBe("own@example.com");
    expect(mockPrisma.member.findUnique).not.toHaveBeenCalled();
  });

  it("returns own email when inheritEmailFromId is undefined", async () => {
    const { getEffectiveEmail } = await import("../member-utils");
    const member = { email: "own@example.com" };
    expect(await getEffectiveEmail(member)).toBe("own@example.com");
    expect(mockPrisma.member.findUnique).not.toHaveBeenCalled();
  });

  it("returns pre-loaded inheritEmailFrom.email without a DB lookup", async () => {
    const { getEffectiveEmail } = await import("../member-utils");
    const member = {
      email: "child@example.com",
      inheritEmailFromId: "adult-1",
      inheritEmailFrom: { email: "parent@example.com" },
    };
    expect(await getEffectiveEmail(member)).toBe("parent@example.com");
    // No DB call needed — data was pre-loaded
    expect(mockPrisma.member.findUnique).not.toHaveBeenCalled();
  });

  it("does a DB lookup when inheritEmailFromId is set but inheritEmailFrom is not loaded", async () => {
    const { getEffectiveEmail } = await import("../member-utils");
    mockPrisma.member.findUnique.mockResolvedValueOnce({ email: "adult@example.com" });

    const member = {
      email: "child@example.com",
      inheritEmailFromId: "adult-1",
    };
    expect(await getEffectiveEmail(member)).toBe("adult@example.com");
    expect(mockPrisma.member.findUnique).toHaveBeenCalledWith({
      where: { id: "adult-1" },
      select: { email: true },
    });
  });

  it("falls back to own email when DB lookup returns null (referenced member deleted)", async () => {
    const { getEffectiveEmail } = await import("../member-utils");
    mockPrisma.member.findUnique.mockResolvedValueOnce(null);

    const member = {
      email: "child@example.com",
      inheritEmailFromId: "missing-id",
    };
    expect(await getEffectiveEmail(member)).toBe("child@example.com");
  });

  it("returns pre-loaded email even when inheritEmailFrom is null (explicitly null = no source)", async () => {
    const { getEffectiveEmail } = await import("../member-utils");
    // inheritEmailFromId set but relation resolved to null (shouldn't happen in
    // practice but the helper should still do a DB lookup)
    mockPrisma.member.findUnique.mockResolvedValueOnce({ email: "adult@example.com" });

    const member = {
      email: "child@example.com",
      inheritEmailFromId: "adult-1",
      inheritEmailFrom: null,
    };
    // inheritEmailFrom is null so it falls through to DB lookup
    expect(await getEffectiveEmail(member)).toBe("adult@example.com");
    expect(mockPrisma.member.findUnique).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Integration-style: email notifications use effective email
// ---------------------------------------------------------------------------

describe("Notification emails use effective email for dependent guests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves inherited email for a dependent member with inheritEmailFromId", async () => {
    const { getEffectiveEmail } = await import("../member-utils");

    // Simulate a child guest whose member record has inheritEmailFromId set
    const dependentMember = {
      email: "child@example.com",          // own (or parent-copied) email
      inheritEmailFromId: "step-parent-id",
      inheritEmailFrom: { email: "stepparent@example.com" },
    };

    const email = await getEffectiveEmail(dependentMember);
    expect(email).toBe("stepparent@example.com");
  });

  it("resolves own email when member has no email inheritance configured", async () => {
    const { getEffectiveEmail } = await import("../member-utils");

    // Primary member — no inheritance at all
    const primaryMember = {
      email: "primary@example.com",
      inheritEmailFromId: null,
    };

    expect(await getEffectiveEmail(primaryMember)).toBe("primary@example.com");
  });

  it("falls back to parent email when inheritParentEmail copies email but inheritEmailFromId is null", async () => {
    const { getEffectiveEmail } = await import("../member-utils");

    // With inheritParentEmail=true, the email field is already set to parent's email
    // at DB level. inheritEmailFromId is null so getEffectiveEmail returns member.email.
    const dependentWithCopiedEmail = {
      email: "parent@example.com",   // copied from parent at DB level
      inheritEmailFromId: null,
    };

    expect(await getEffectiveEmail(dependentWithCopiedEmail)).toBe("parent@example.com");
    expect(mockPrisma.member.findUnique).not.toHaveBeenCalled();
  });
});
