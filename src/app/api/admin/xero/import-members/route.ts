import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { importMembersFromXeroGroups } from "@/lib/xero";

const importSchema = z.object({
  groupMappings: z.array(
    z.object({
      groupId: z.string().min(1),
      groupName: z.string().min(1),
      ageTier: z.enum(["ADULT", "YOUTH", "CHILD"]),
    })
  ).min(1, "At least one group mapping is required"),
  sendInvites: z.boolean().default(false),
});

/**
 * POST /api/admin/xero/import-members
 * Import members from Xero contact groups into TACBookings.
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
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
    console.log("[import-members] Starting import with", parsed.data.groupMappings.length, "group(s):", parsed.data.groupMappings.map(g => `${g.groupName} (${g.ageTier})`).join(", "));
    const result = await importMembersFromXeroGroups(
      parsed.data.groupMappings,
      parsed.data.sendInvites
    );
    console.log("[import-members] Result:", JSON.stringify(result));
    return NextResponse.json(result);
  } catch (error) {
    console.error("[import-members] Error:", error);
    const message =
      error instanceof Error ? error.message : "Member import failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
