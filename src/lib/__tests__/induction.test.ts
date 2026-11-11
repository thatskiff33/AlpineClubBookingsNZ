import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { prismaMock, txMock } = vi.hoisted(() => {
  const txMock = {
    memberInduction: { findUnique: vi.fn(), update: vi.fn() },
    memberInductionSignOff: {
      findUnique: vi.fn(),
      create: vi.fn(),
      count: vi.fn(),
    },
    memberInductionAssignedSigner: {
      deleteMany: vi.fn(),
      createMany: vi.fn(),
    },
    member: { update: vi.fn() },
  };
  return {
    txMock,
    prismaMock: {
      $transaction: vi.fn(async (cb: (tx: typeof txMock) => unknown) => cb(txMock)),
      member: { count: vi.fn() },
      memberInduction: { findUnique: vi.fn() },
    },
  };
});

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }));
vi.mock("@/lib/membership-nomination-settings", () => ({
  loadMembershipNominationSettings: vi.fn().mockResolvedValue({
    gateEnabled: true,
    minimumMembershipMonths: 12,
    minimumNights: 6,
    requiredSignOffs: 2,
    gateEffectiveFrom: null,
  }),
}));

import {
  addSignOff,
  canSignOff,
  InductionError,
  reassignInductionSigners,
  resolveSignerRole,
} from "@/lib/induction";

const ctxNominator = { memberId: "nom1", isAdmin: false, isHutLeader: false };
const ctxHutLeader = { memberId: "hl1", isAdmin: false, isHutLeader: true };
const ctxAdmin = { memberId: "adm1", isAdmin: true, isHutLeader: false };
const ctxStranger = { memberId: "x1", isAdmin: false, isHutLeader: false };

const application = { nominator1Id: "nom1", nominator2Id: "nom2" };

describe("resolveSignerRole", () => {
  it("treats a nominator of the inductee as NOMINATOR", () => {
    expect(resolveSignerRole(ctxNominator, application)).toBe("NOMINATOR");
  });
  it("falls back to HUT_LEADER then ADMIN", () => {
    expect(resolveSignerRole(ctxHutLeader, application)).toBe("HUT_LEADER");
    expect(resolveSignerRole(ctxAdmin, application)).toBe("ADMIN");
  });
  it("returns null for an unrelated member", () => {
    expect(resolveSignerRole(ctxStranger, application)).toBeNull();
  });
  it("treats explicitly assigned signers as NOMINATOR fallback", () => {
    expect(resolveSignerRole(ctxStranger, application, ["x1"])).toBe("NOMINATOR");
  });
});

describe("canSignOff", () => {
  type SignableInduction = Parameters<typeof canSignOff>[0];
  const signable = {
    status: "IN_PROGRESS" as const,
    memberId: "inductee",
    signOffs: [] as Array<{ signerMemberId: string | null }>,
    assignedSigners: [] as Array<{ memberId: string }>,
    application,
  } as unknown as SignableInduction;

  it("allows an authorised, unsigned nominator", () => {
    const result = canSignOff(signable, ctxNominator);
    expect(result.allowed).toBe(true);
    expect(result.role).toBe("NOMINATOR");
  });

  it("rejects signing your own induction", () => {
    const result = canSignOff(
      { ...signable, memberId: "nom1" },
      ctxNominator
    );
    expect(result.allowed).toBe(false);
  });

  it("rejects a completed induction", () => {
    const result = canSignOff(
      { ...signable, status: "COMPLETED" },
      ctxNominator
    );
    expect(result.allowed).toBe(false);
  });

  it("rejects a duplicate signer", () => {
    const result = canSignOff(
      {
        ...signable,
        signOffs: [{ signerMemberId: "nom1" }] as unknown as SignableInduction["signOffs"],
      },
      ctxNominator
    );
    expect(result.allowed).toBe(false);
  });
});

describe("addSignOff", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.$transaction.mockImplementation(
      async (cb: (tx: typeof txMock) => unknown) => cb(txMock)
    );
    txMock.memberInduction.findUnique.mockResolvedValue({
      id: "i1",
      status: "IN_PROGRESS",
      requiredSignOffs: 2,
      inductionDate: null,
      memberId: "inductee",
      kind: "NEW_MEMBER",
    });
    txMock.memberInductionSignOff.findUnique.mockResolvedValue(null);
    txMock.memberInductionSignOff.create.mockResolvedValue({});
    txMock.memberInduction.update.mockResolvedValue({ id: "i1" });
    txMock.member.update.mockResolvedValue({});
  });

  it("rejects when the declaration is not accepted", async () => {
    await expect(
      addSignOff({
        inductionId: "i1",
        signerMemberId: "nom1",
        signerName: "Nom One",
        signerRole: "NOMINATOR",
        declarationAccepted: false,
      })
    ).rejects.toBeInstanceOf(InductionError);
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it("completes the induction once required sign-offs are reached", async () => {
    txMock.memberInductionSignOff.count.mockResolvedValue(2);

    const result = await addSignOff({
      inductionId: "i1",
      signerMemberId: "nom1",
      signerName: "Nom One",
      signerRole: "NOMINATOR",
      declarationAccepted: true,
    });

    expect(result.completed).toBe(true);
    expect(result.signOffCount).toBe(2);
    const updateArg = txMock.memberInduction.update.mock.calls[0][0];
    expect(updateArg.data.status).toBe("COMPLETED");
    expect(updateArg.data.completionSource).toBe("SIGN_OFFS");
    expect(txMock.member.update).not.toHaveBeenCalled();
  });

  it("marks the member hut-leader-eligible when a hut-leader induction completes", async () => {
    txMock.memberInduction.findUnique.mockResolvedValue({
      id: "i1",
      status: "IN_PROGRESS",
      requiredSignOffs: 1,
      inductionDate: null,
      memberId: "inductee",
      kind: "HUT_LEADER",
    });
    txMock.memberInductionSignOff.count.mockResolvedValue(1);

    await addSignOff({
      inductionId: "i1",
      signerMemberId: "nom1",
      signerName: "Nom One",
      signerRole: "NOMINATOR",
      declarationAccepted: true,
    });

    expect(txMock.member.update).toHaveBeenCalledWith({
      where: { id: "inductee" },
      data: {
        hutLeaderEligible: true,
        hutLeaderEligibleAt: expect.any(Date),
      },
    });
  });

  it("stays in progress below the required sign-off count", async () => {
    txMock.memberInductionSignOff.count.mockResolvedValue(1);

    const result = await addSignOff({
      inductionId: "i1",
      signerMemberId: "nom1",
      signerName: "Nom One",
      signerRole: "NOMINATOR",
      declarationAccepted: true,
    });

    expect(result.completed).toBe(false);
    const updateArg = txMock.memberInduction.update.mock.calls[0][0];
    expect(updateArg.data.status).toBeUndefined();
  });

  it("rejects a duplicate sign-off", async () => {
    txMock.memberInductionSignOff.findUnique.mockResolvedValue({ id: "existing" });
    await expect(
      addSignOff({
        inductionId: "i1",
        signerMemberId: "nom1",
        signerName: "Nom One",
        signerRole: "NOMINATOR",
        declarationAccepted: true,
      })
    ).rejects.toBeInstanceOf(InductionError);
  });
});

describe("reassignInductionSigners", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.$transaction.mockImplementation(
      async (cb: (tx: typeof txMock) => unknown) => cb(txMock)
    );
    prismaMock.memberInduction.findUnique.mockResolvedValue({
      id: "i1",
      memberId: "inductee",
      status: "IN_PROGRESS",
      assignedSigners: [{ memberId: "old1" }],
    });
    prismaMock.member.count.mockResolvedValue(2);
  });

  it("replaces explicit assigned signer rows", async () => {
    await reassignInductionSigners({
      inductionId: "i1",
      adminMemberId: "admin1",
      signerMemberIds: ["new1", "new2", "new1", "inductee"],
    });

    expect(txMock.memberInductionAssignedSigner.deleteMany).toHaveBeenCalledWith({
      where: {
        inductionId: "i1",
        memberId: { notIn: ["new1", "new2"] },
      },
    });
    expect(txMock.memberInductionAssignedSigner.createMany).toHaveBeenCalledWith({
      data: [
        { inductionId: "i1", memberId: "new1" },
        { inductionId: "i1", memberId: "new2" },
      ],
      skipDuplicates: true,
    });
  });
});

it("completes a hut-leader sign-off by inserting the sign-off, then the member, then the induction (#4876)", () => {
  const source = readFileSync(path.join(process.cwd(), "src/lib/induction.ts"), "utf8");
  const body = source.slice(
    source.indexOf("export async function addSignOff"),
    source.indexOf("export async function overrideCompleteInduction"),
  );
  const inserted = body.indexOf("memberInductionSignOff.create");
  const member = body.indexOf("applyCompletionSideEffects");
  const induction = body.indexOf("memberInduction.update");
  expect(inserted).toBeGreaterThan(-1);
  expect(member).toBeGreaterThan(inserted);
  expect(induction).toBeGreaterThan(member);
});
