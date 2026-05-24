import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { getXeroAdminHealthSnapshot } from "@/lib/xero-admin-health";
import logger from "@/lib/logger";

export async function GET() {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  try {
    const snapshot = await getXeroAdminHealthSnapshot();
    return NextResponse.json(snapshot);
  } catch (error) {
    logger.error({ err: error }, "Failed to load Xero admin health snapshot");
    return NextResponse.json(
      { error: "Failed to load Xero admin health snapshot" },
      { status: 500 }
    );
  }
}
