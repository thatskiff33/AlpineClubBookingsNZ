import "server-only";

import type {
  PrismaClient,
  InductionKind,
  InductionSignerRole,
  InductionStatus,
  Prisma,
} from "@prisma/client";
import { logAudit } from "@/lib/audit";
import { loadMembershipNominationSettings } from "@/lib/membership-nomination-settings";
import { prisma } from "@/lib/prisma";

export class InductionError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "InductionError";
    this.status = status;
  }
}

// Statuses from which an induction can still receive sign-offs.
const SIGNABLE_INDUCTION_STATUSES: InductionStatus[] = [
  "DRAFT",
  "IN_PROGRESS",
];

const TEMPLATE_INCLUDE = {
  sections: {
    orderBy: { sortOrder: "asc" },
    include: { items: { orderBy: { sortOrder: "asc" } } },
  },
} satisfies Prisma.InductionChecklistTemplateInclude;

const INDUCTION_INCLUDE = {
  member: {
    select: {
      id: true,
      firstName: true,
      lastName: true,
    },
  },
  template: { include: TEMPLATE_INCLUDE },
  signOffs: { orderBy: { signedAt: "asc" } },
  application: { select: { nominator1Id: true, nominator2Id: true } },
  assignedSigners: {
    include: {
      member: { select: { id: true, firstName: true, lastName: true } },
    },
  },
} satisfies Prisma.MemberInductionInclude;

export type MemberInductionWithDetail = Prisma.MemberInductionGetPayload<{
  include: typeof INDUCTION_INCLUDE;
}>;

/**
 * Create a new induction record for a member against the active template.
 * Snapshots requiredSignOffs from settings so later setting changes do not move
 * the goalposts on an in-flight induction.
 * signerMemberIds: explicitly assigned signers (used for re-inductions without a
 * nomination application, or when the admin wants to designate specific people).
 */
export async function createMemberInduction(params: {
  memberId: string;
  kind?: InductionKind;
  applicationId?: string | null;
  createdByMemberId?: string | null;
  signerMemberIds?: string[];
}) {
  const kind = params.kind ?? "NEW_MEMBER";
  const signerMemberIds = Array.from(
    new Set((params.signerMemberIds ?? []).filter((id) => id !== params.memberId)),
  );
  const template = await prisma.inductionChecklistTemplate.findFirst({
    where: { isActive: true, kind },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  if (!template) {
    throw new InductionError(
      `No active ${kind.toLowerCase().replaceAll("_", " ")} induction checklist template is configured`,
      409,
    );
  }

  const settings = await loadMembershipNominationSettings();

  const induction = await prisma.memberInduction.create({
    data: {
      memberId: params.memberId,
      templateId: template.id,
      applicationId: params.applicationId ?? null,
      kind,
      status: "IN_PROGRESS",
      requiredSignOffs: settings.requiredSignOffs,
      createdByMemberId: params.createdByMemberId ?? null,
      ...(signerMemberIds.length
        ? {
            assignedSigners: {
              create: signerMemberIds.map((id) => ({ memberId: id })),
            },
          }
        : {}),
    },
  });

  logAudit({
    action: "MEMBER_INDUCTION_CREATED",
    memberId: params.createdByMemberId ?? undefined,
    targetId: induction.id,
    subjectMemberId: params.memberId,
    entityType: "MemberInduction",
    entityId: induction.id,
    category: "lodge",
    details: JSON.stringify({
      kind: induction.kind,
      applicationId: params.applicationId ?? null,
      assignedSignerCount: signerMemberIds.length,
    }),
  });

  return induction;
}

export interface AddSignOffParams {
  inductionId: string;
  signerMemberId: string;
  signerName: string;
  signerRole: InductionSignerRole;
  declarationAccepted: boolean;
  comments?: string | null;
}

async function applyCompletionSideEffects(
  tx: Prisma.TransactionClient,
  induction: { memberId: string; kind: InductionKind },
  completedAt: Date,
) {
  if (induction.kind !== "HUT_LEADER") return;
  await tx.member.update({
    where: { id: induction.memberId },
    data: {
      hutLeaderEligible: true,
      hutLeaderEligibleAt: completedAt,
    },
  });
}

/**
 * Record a single Pass sign-off against an induction, then auto-complete the
 * induction once the required number of sign-offs is reached.
 */
export async function addSignOff(params: AddSignOffParams) {
  if (!params.declarationAccepted) {
    throw new InductionError(
      "You must accept the declaration to sign off the induction",
      422,
    );
  }

  const result = await prisma.$transaction(async (tx) => {
    const induction = await tx.memberInduction.findUnique({
      where: { id: params.inductionId },
      select: {
        id: true,
        status: true,
        requiredSignOffs: true,
        inductionDate: true,
        memberId: true,
        kind: true,
      },
    });
    if (!induction) {
      throw new InductionError("Induction not found", 404);
    }
    if (induction.memberId === params.signerMemberId) {
      throw new InductionError("You cannot sign off your own induction", 403);
    }
    if (!SIGNABLE_INDUCTION_STATUSES.includes(induction.status)) {
      throw new InductionError("This induction is not open for sign-off", 409);
    }

    const existing = await tx.memberInductionSignOff.findUnique({
      where: {
        inductionId_signerMemberId: {
          inductionId: params.inductionId,
          signerMemberId: params.signerMemberId,
        },
      },
      select: { id: true },
    });
    if (existing) {
      throw new InductionError(
        "You have already signed off this induction",
        409,
      );
    }

    await tx.memberInductionSignOff.create({
      data: {
        inductionId: params.inductionId,
        signerMemberId: params.signerMemberId,
        signerName: params.signerName,
        signerRole: params.signerRole,
        declarationAccepted: true,
        comments: params.comments ?? null,
      },
    });

    const signOffCount = await tx.memberInductionSignOff.count({
      where: { inductionId: params.inductionId },
    });

    const updateData: Prisma.MemberInductionUpdateInput = {};
    if (!induction.inductionDate) {
      updateData.inductionDate = new Date();
    }
    const completed = signOffCount >= induction.requiredSignOffs;
    const completedAt = new Date();
    if (completed) {
      updateData.status = "COMPLETED";
      updateData.completedAt = completedAt;
      updateData.completionSource = "SIGN_OFFS";
      await applyCompletionSideEffects(tx, induction, completedAt);
    }

    const updated = await tx.memberInduction.update({
      where: { id: params.inductionId },
      data: updateData,
    });

    return {
      induction: updated,
      signOffCount,
      completed,
      memberId: induction.memberId,
    };
  });

  logAudit({
    action: result.completed
      ? "MEMBER_INDUCTION_COMPLETED"
      : "MEMBER_INDUCTION_SIGNED_OFF",
    memberId: params.signerMemberId,
    targetId: params.inductionId,
    subjectMemberId: result.memberId,
    entityType: "MemberInduction",
    entityId: params.inductionId,
    category: "lodge",
    severity: result.completed ? "important" : "info",
    details: JSON.stringify({
      signerRole: params.signerRole,
      signOffCount: result.signOffCount,
      completed: result.completed,
    }),
  });

  return result;
}

/** Admin force-complete (override) an induction regardless of sign-off count. */
export async function overrideCompleteInduction(params: {
  inductionId: string;
  adminMemberId: string;
  comments?: string | null;
}) {
  const induction = await prisma.memberInduction.findUnique({
    where: { id: params.inductionId },
    select: { id: true, status: true, memberId: true, kind: true },
  });
  if (!induction) {
    throw new InductionError("Induction not found", 404);
  }
  if (induction.status === "COMPLETED") {
    return induction;
  }
  if (induction.status === "VOIDED") {
    throw new InductionError("A voided induction cannot be completed", 409);
  }

  const completedAt = new Date();
  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.memberInduction.update({
      where: { id: params.inductionId },
      data: {
        status: "COMPLETED",
        completedAt,
        completionSource: "ADMIN_OVERRIDE",
        ...(params.comments ? { finalComments: params.comments } : {}),
      },
    });
    await applyCompletionSideEffects(tx, induction, completedAt);
    return result;
  });

  logAudit({
    action: "MEMBER_INDUCTION_OVERRIDE_COMPLETED",
    memberId: params.adminMemberId,
    targetId: params.inductionId,
    subjectMemberId: induction.memberId,
    entityType: "MemberInduction",
    entityId: params.inductionId,
    category: "lodge",
    severity: "important",
    details: params.comments ?? null,
  });

  return updated;
}

export async function reassignInductionSigners(params: {
  inductionId: string;
  adminMemberId: string;
  signerMemberIds: string[];
}) {
  const induction = await prisma.memberInduction.findUnique({
    where: { id: params.inductionId },
    include: { assignedSigners: { select: { memberId: true } } },
  });
  if (!induction) {
    throw new InductionError("Induction not found", 404);
  }
  if (induction.status === "VOIDED") {
    throw new InductionError("A voided induction cannot be reassigned", 409);
  }

  const signerMemberIds = Array.from(
    new Set(params.signerMemberIds.filter((id) => id !== induction.memberId)),
  );
  if (signerMemberIds.length > 0) {
    const existingCount = await prisma.member.count({
      where: { id: { in: signerMemberIds } },
    });
    if (existingCount !== signerMemberIds.length) {
      throw new InductionError("One or more assigned signers were not found", 404);
    }
  }

  await prisma.$transaction(async (tx) => {
    await tx.memberInductionAssignedSigner.deleteMany({
      where: {
        inductionId: params.inductionId,
        ...(signerMemberIds.length
          ? { memberId: { notIn: signerMemberIds } }
          : {}),
      },
    });
    if (signerMemberIds.length > 0) {
      await tx.memberInductionAssignedSigner.createMany({
        data: signerMemberIds.map((memberId) => ({
          inductionId: params.inductionId,
          memberId,
        })),
        skipDuplicates: true,
      });
    }
  });

  logAudit({
    action: "MEMBER_INDUCTION_SIGNERS_REASSIGNED",
    memberId: params.adminMemberId,
    targetId: params.inductionId,
    subjectMemberId: induction.memberId,
    entityType: "MemberInduction",
    entityId: params.inductionId,
    category: "lodge",
    severity: "important",
    details: JSON.stringify({
      before: induction.assignedSigners.map((signer) => signer.memberId),
      after: signerMemberIds,
    }),
  });
}

/** Admin void an induction (e.g. created in error, member departed). */
export async function voidInduction(params: {
  inductionId: string;
  adminMemberId: string;
  reason: string;
}) {
  const induction = await prisma.memberInduction.findUnique({
    where: { id: params.inductionId },
    select: { id: true, status: true, memberId: true },
  });
  if (!induction) {
    throw new InductionError("Induction not found", 404);
  }
  if (induction.status === "VOIDED") {
    return induction;
  }

  const updated = await prisma.memberInduction.update({
    where: { id: params.inductionId },
    data: { status: "VOIDED", voidedReason: params.reason },
  });

  logAudit({
    action: "MEMBER_INDUCTION_VOIDED",
    memberId: params.adminMemberId,
    targetId: params.inductionId,
    subjectMemberId: induction.memberId,
    entityType: "MemberInduction",
    entityId: params.inductionId,
    category: "lodge",
    severity: "important",
    details: params.reason,
  });

  return updated;
}

/** The member's most recent induction with full detail (for their own page). */
export async function getInductionForMember(
  memberId: string,
): Promise<MemberInductionWithDetail | null> {
  return prisma.memberInduction.findFirst({
    where: { memberId },
    orderBy: { createdAt: "desc" },
    include: INDUCTION_INCLUDE,
  });
}

/**
 * The STATUS of the member's most recent induction, and nothing else.
 *
 * Same record `getInductionForMember` returns — the newest by `createdAt` of ANY
 * `InductionKind`, one derivation of "most recent" shared by both — but projected
 * down to the one column a caller that only needs the state can use.
 *
 * It exists for AI Diagnostics (#2376). `getInductionForMember` is written for the
 * member's own induction page and its `include` pulls the whole record graph:
 * `finalComments`, `voidedReason`, every sign-off's `comments` and `signerName`,
 * the template's `competencyPrompt`, `notesPrompt` and `legacySourceText`, the
 * assigned signers' names and the inductee's name. That is health, safety and
 * competency data, and the diagnostics evidence source that needed only `.status`
 * documents its named `select` clauses as the only boundary between it and columns
 * like those. Nothing leaked — the projection consumed one field — but the read
 * did not honour the claim the module is reviewed against, so the narrow read
 * lives here rather than the wide one being trusted there.
 */
export async function getInductionStatusForMember(
  memberId: string,
  /**
   * A caller inside a bounded read-only transaction MUST pass it, so this read sits
   * under that transaction's snapshot and statement timeout rather than on a second
   * connection outside both.
   */
  db: Pick<PrismaClient, "memberInduction"> = prisma,
): Promise<InductionStatus | null> {
  const induction = await db.memberInduction.findFirst({
    where: { memberId },
    orderBy: { createdAt: "desc" },
    select: { status: true },
  });
  return induction?.status ?? null;
}

export async function getInductionById(
  inductionId: string,
): Promise<MemberInductionWithDetail | null> {
  return prisma.memberInduction.findUnique({
    where: { id: inductionId },
    include: INDUCTION_INCLUDE,
  });
}

export interface SignerContext {
  memberId: string;
  isAdmin: boolean;
  isHutLeader: boolean;
}

/**
 * Determine which role a prospective signer would sign in. Nominators of the
 * inductee take precedence (including explicitly assigned signers), then hut
 * leaders, then admins. Returns null when the signer has no basis to sign.
 */
export function resolveSignerRole(
  ctx: SignerContext,
  application: { nominator1Id: string | null; nominator2Id: string | null } | null,
  assignedSignerIds?: string[],
): InductionSignerRole | null {
  if (
    application &&
    (application.nominator1Id === ctx.memberId ||
      application.nominator2Id === ctx.memberId)
  ) {
    return "NOMINATOR";
  }
  if (assignedSignerIds?.includes(ctx.memberId)) {
    return "NOMINATOR";
  }
  if (ctx.isHutLeader) {
    return "HUT_LEADER";
  }
  if (ctx.isAdmin) {
    return "ADMIN";
  }
  return null;
}

export interface SignOffEligibility {
  allowed: boolean;
  role?: InductionSignerRole;
  reason?: string;
}

/** Whether the signer may add a sign-off to this induction right now. */
export function canSignOff(
  induction: Pick<MemberInductionWithDetail, "status" | "memberId" | "signOffs" | "application" | "assignedSigners">,
  ctx: SignerContext,
): SignOffEligibility {
  if (!SIGNABLE_INDUCTION_STATUSES.includes(induction.status)) {
    return { allowed: false, reason: "This induction is not open for sign-off" };
  }
  if (induction.memberId === ctx.memberId) {
    return { allowed: false, reason: "You cannot sign off your own induction" };
  }
  if (induction.signOffs.some((s) => s.signerMemberId === ctx.memberId)) {
    return { allowed: false, reason: "You have already signed off this induction" };
  }
  const assignedIds = induction.assignedSigners.map((s) => s.memberId);
  const role = resolveSignerRole(ctx, induction.application, assignedIds);
  if (!role) {
    return { allowed: false, reason: "You are not authorised to sign off this induction" };
  }
  return { allowed: true, role };
}

/** Inductions the signer is authorised to sign and has not yet signed. */
export async function listInductionsAwaitingSignOff(ctx: SignerContext) {
  const authorizationFilter: Prisma.MemberInductionWhereInput =
    ctx.isHutLeader || ctx.isAdmin
      ? {}
      : {
          OR: [
            {
              application: {
                OR: [
                  { nominator1Id: ctx.memberId },
                  { nominator2Id: ctx.memberId },
                ],
              },
            },
            {
              assignedSigners: { some: { memberId: ctx.memberId } },
            },
          ],
        };

  return prisma.memberInduction.findMany({
    where: {
      status: { in: SIGNABLE_INDUCTION_STATUSES },
      memberId: { not: ctx.memberId },
      signOffs: { none: { signerMemberId: ctx.memberId } },
      ...authorizationFilter,
    },
    include: {
      member: { select: { id: true, firstName: true, lastName: true } },
      application: { select: { nominator1Id: true, nominator2Id: true } },
      assignedSigners: { select: { memberId: true } },
      _count: { select: { signOffs: true } },
    },
    orderBy: { createdAt: "asc" },
  });
}
