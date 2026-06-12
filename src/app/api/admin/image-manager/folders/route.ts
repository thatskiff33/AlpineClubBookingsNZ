import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/session-guards";
import { createImageDirectory } from "@/lib/image-manager";

export const runtime = "nodejs";

const createFolderSchema = z
  .object({
    currentDir: z.string().optional().default(""),
    folderName: z.string().trim().min(1).max(120),
  })
  .strict();

function unauthorizedResponse() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

const adminGuardOptions = {
  forbiddenResponse: unauthorizedResponse,
};

export async function POST(request: NextRequest) {
  const guard = await requireAdmin(adminGuardOptions);
  if (!guard.ok) {
    return guard.response;
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = createFolderSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    const relativePath = await createImageDirectory(
      parsed.data.currentDir,
      parsed.data.folderName,
    );

    return NextResponse.json({ relativePath }, { status: 201 });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to create folder";
    const status = message === "That directory already exists" ? 409 : 400;

    return NextResponse.json({ error: message }, { status });
  }
}
