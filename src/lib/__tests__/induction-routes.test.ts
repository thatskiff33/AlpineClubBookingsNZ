import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  requireActiveSession: vi.fn(),
  hasActiveHutLeaderAssignment: vi.fn(),
  getInductionById: vi.fn(),
  resolveSignerRole: vi.fn(),
  canSignOff: vi.fn(),
  addSignOff: vi.fn(),
  memberFindUnique: vi.fn(),
}));

vi.mock("@/lib/session-guards", () => ({
  requireActiveSession: mocks.requireActiveSession,
}));

vi.mock("@/lib/hut-leader", () => ({
  hasActiveHutLeaderAssignment: mocks.hasActiveHutLeaderAssignment,
}));

vi.mock("@/lib/induction", async (importOriginal) => {
  // The route's own view mapper, so the test reads what the route really sends.
  // And the signer reading, so the hut-leader and role mocks reach it.
  const { inductionSignerContext, memberInductionView } = (await importOriginal()) as typeof import("@/lib/induction");
  class InductionError extends Error {
    status: number;

    constructor(message: string, status = 400) {
      super(message);
      this.name = "InductionError";
      this.status = status;
    }
  }

  return {
    addSignOff: mocks.addSignOff,
    canSignOff: mocks.canSignOff,
    getInductionById: mocks.getInductionById,
    inductionSignerContext,
    InductionError,
    memberInductionView,
    resolveSignerRole: mocks.resolveSignerRole,
  };
});

vi.mock("@/lib/logger", () => ({
  default: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: {
      findUnique: mocks.memberFindUnique,
    },
  },
}));

import { GET as inductionDetailGET } from "@/app/api/inductions/[id]/route";
import { POST as signOffPOST } from "@/app/api/inductions/[id]/sign-off/route";

const unrelatedMemberSession = {
  user: {
    id: "member-2",
    role: "MEMBER",
    email: "member-2@example.com",
  },
};

const inductionForAnotherMember = {
  id: "induction-1",
  memberId: "member-1",
  status: "IN_PROGRESS",
  signOffs: [],
  assignedSigners: [],
  application: {
    nominator1Id: "nominator-1",
    nominator2Id: "nominator-2",
  },
};

function routeParams(id = "induction-1") {
  return { params: Promise.resolve({ id }) };
}

function request(path: string, body: unknown) {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireActiveSession.mockResolvedValue({
    ok: true,
    session: unrelatedMemberSession,
  });
  mocks.hasActiveHutLeaderAssignment.mockResolvedValue(false);
  mocks.getInductionById.mockResolvedValue(inductionForAnotherMember);
  mocks.resolveSignerRole.mockReturnValue(null);
  mocks.canSignOff.mockReturnValue({
    allowed: false,
    reason: "You are not authorised to sign off this induction",
  });
});

describe("induction route boundaries", () => {
  it("does not expose induction details to an unrelated member", async () => {
    const response = await inductionDetailGET(
      new NextRequest("http://localhost/api/inductions/induction-1"),
      routeParams(),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Forbidden" });
    expect(mocks.getInductionById).toHaveBeenCalledWith("induction-1");
    expect(mocks.resolveSignerRole).toHaveBeenCalledWith(
      {
        memberId: "member-2",
        isAdmin: false,
        isHutLeader: false,
      },
      inductionForAnotherMember.application,
      [],
    );
    expect(mocks.canSignOff).not.toHaveBeenCalled();
  });

  it("does not treat operational accounts as hut-leader signers", async () => {
    mocks.requireActiveSession.mockResolvedValue({
      ok: true,
      session: {
        user: {
          id: "lodge-1",
          role: "LODGE",
          email: "lodge@example.com",
        },
      },
    });
    mocks.hasActiveHutLeaderAssignment.mockResolvedValue(true);

    const response = await inductionDetailGET(
      new NextRequest("http://localhost/api/inductions/induction-1"),
      routeParams(),
    );

    expect(response.status).toBe(403);
    expect(mocks.hasActiveHutLeaderAssignment).not.toHaveBeenCalled();
    expect(mocks.resolveSignerRole).toHaveBeenCalledWith(
      {
        memberId: "lodge-1",
        isAdmin: false,
        isHutLeader: false,
      },
      inductionForAnotherMember.application,
      [],
    );
  });

  it("does not expose member emails in member-facing induction detail", async () => {
    mocks.getInductionById.mockResolvedValue({
      ...inductionForAnotherMember,
      memberId: "member-2",
      member: {
        id: "member-2",
        firstName: "Inducted",
        lastName: "Member",
        email: "inducted@example.com",
      },
      assignedSigners: [
        {
          memberId: "signer-1",
          emailSentAt: null,
          member: {
            id: "signer-1",
            firstName: "Assigned",
            lastName: "Signer",
            email: "signer@example.com",
          },
        },
      ],
    });

    const response = await inductionDetailGET(
      new NextRequest("http://localhost/api/inductions/induction-1"),
      routeParams(),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.induction.member).toEqual({
      id: "member-2",
      firstName: "Inducted",
      lastName: "Member",
    });
    expect(body.induction.assignedSigners).toEqual([
      {
        memberId: "signer-1",
        firstName: "Assigned",
        lastName: "Signer",
        emailSentAt: null,
      },
    ]);
  });

  it("does not let an unrelated member sign off another member induction", async () => {
    const response = await signOffPOST(
      request("/api/inductions/induction-1/sign-off", {
        declarationAccepted: true,
      }),
      routeParams(),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "You are not authorised to sign off this induction",
    });
    expect(mocks.memberFindUnique).not.toHaveBeenCalled();
    expect(mocks.addSignOff).not.toHaveBeenCalled();
  });
});
