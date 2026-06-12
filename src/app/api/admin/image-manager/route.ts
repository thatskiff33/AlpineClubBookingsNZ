import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import { listImageDirectory } from "@/lib/image-manager";

export const runtime = "nodejs";

function unauthorizedResponse() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

const adminGuardOptions = {
  forbiddenResponse: unauthorizedResponse,
};

export async function GET(request: NextRequest) {
  const guard = await requireAdmin(adminGuardOptions);
  if (!guard.ok) {
    return guard.response;
  }

  const dir = request.nextUrl.searchParams.get("dir") ?? "";

  try {
    const listing = await listImageDirectory(dir);
    return NextResponse.json({ listing });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to load image directory";
    const status = message === "Directory not found" ? 404 : 400;

    return NextResponse.json({ error: message }, { status });
  }
}
