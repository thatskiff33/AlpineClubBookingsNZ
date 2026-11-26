import { prisma } from "@/lib/prisma";

/** Officer-only list of deductions reserved while their Xero correction runs. */
export async function getPendingCreditDeductionCorrections(memberId: string) {
  const corrections = await prisma.adminCreditDeductionCorrection.findMany({
    where: { memberId, status: "RESERVED" },
    select: {
      id: true,
      requestId: true,
      createdAt: true,
      request: { select: { amountCents: true, description: true } },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  return corrections.map(({ request, ...correction }) => ({ ...correction, ...request }));
}
