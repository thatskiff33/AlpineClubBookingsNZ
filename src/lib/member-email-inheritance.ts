import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";

type InheritanceValidationResult =
  | { ok: true }
  | { ok: false; status: 404 | 422; error: string };

export async function validateInheritEmailSource(input: {
  inheritEmailFromId: string;
  memberId?: string;
  db?: Prisma.TransactionClient | typeof prisma;
}): Promise<InheritanceValidationResult> {
  const db = input.db ?? prisma;
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
