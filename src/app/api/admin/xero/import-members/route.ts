import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ageTierEnum } from "@/lib/age-tier-schema";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { importMembersFromXeroGroups, XeroDailyLimitError } from "@/lib/xero";
import logger from "@/lib/logger";

const importSchema = z.object({
  groupMappings: z.array(
    z.object({
      groupId: z.string().min(1),
      groupName: z.string().min(1),
      ageTier: ageTierEnum,
    })
  ).min(1, "At least one group mapping is required"),
  sendInvites: z.boolean().default(false),
  repairMissingContactCache: z.boolean().default(false),
});

/**
 * POST /api/admin/xero/import-members
 * Import members from cached Xero contact groups into TACBookings.
 * Repair mode can fetch only missing cached contact snapshots from Xero.
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = importSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
      { status: 422 }
    );
  }

  try {
    logger.info({ groupCount: parsed.data.groupMappings.length, groups: parsed.data.groupMappings.map(g => `${g.groupName} (${g.ageTier})`).join(", ") }, "Starting member import from Xero");
    const result = await importMembersFromXeroGroups(
      parsed.data.groupMappings,
      parsed.data.sendInvites,
      { allowLiveXeroFetch: parsed.data.repairMissingContactCache }
    );
    logger.info({ result }, "Member import from Xero completed");
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof XeroDailyLimitError) {
      logger.warn({ err: error }, "Member import hit Xero daily rate limit");
      return NextResponse.json(
        { error: "Xero daily API limit reached. Please try again tomorrow." },
        { status: 429 }
      );
    }
    logger.error({ err: error }, "Member import from Xero failed");
    const message =
      error instanceof Error ? error.message : "Member import failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
