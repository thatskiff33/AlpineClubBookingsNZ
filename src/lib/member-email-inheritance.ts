import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";

type InheritanceValidationResult =
  | { ok: true }
  | { ok: false; status: 404 | 422; error: string };

type EmailInheritanceClient = Prisma.TransactionClient | typeof prisma;

export async function validateInheritEmailSource(input: {
  inheritEmailFromId: string;
  memberId?: string;
  db?: EmailInheritanceClient;
}, dbOverride?: EmailInheritanceClient): Promise<InheritanceValidationResult> {
  const db = dbOverride ?? input.db ?? prisma;
  const inheritEmailFrom = await db.member.findUnique({
    where: { id: input.inheritEmailFromId },
    select: {
      id: true,
      ageTier: true,
      parentMemberId: true,
      inheritEmailFromId: true,
    },
  });

  if (!inheritEmailFrom) {
    return {
      ok: false,
      status: 404,
      error: "Email inheritance member not found",
    };
  }

  if (input.memberId && inheritEmailFrom.id === input.memberId) {
    return {
      ok: false,
      status: 422,
      error: "Email inheritance cannot point to the same member",
    };
  }

  if (inheritEmailFrom.ageTier !== "ADULT") {
    return {
      ok: false,
      status: 422,
      error: "Email inheritance must point to an adult member",
    };
  }

  if (inheritEmailFrom.parentMemberId) {
    return {
      ok: false,
      status: 422,
      error: "Email inheritance must point to a primary adult member",
    };
  }

  if (inheritEmailFrom.inheritEmailFromId) {
    return {
      ok: false,
      status: 422,
      error: "Email inheritance cannot chain through another inherited member",
    };
  }

  return { ok: true };
}
