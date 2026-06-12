import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import { saveImageUploads } from "@/lib/image-manager";

export const runtime = "nodejs";

function unauthorizedResponse() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

const adminGuardOptions = {
  forbiddenResponse: unauthorizedResponse,
};

function isFile(value: FormDataEntryValue): value is File {
  return typeof value !== "string" && value instanceof File;
}

export async function POST(request: NextRequest) {
  const guard = await requireAdmin(adminGuardOptions);
  if (!guard.ok) {
    return guard.response;
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json(
      { error: "Invalid multipart form data" },
      { status: 400 },
    );
  }

  const currentDir = String(formData.get("currentDir") ?? "");
  const uploadedFiles = formData.getAll("files").filter(isFile);

  if (uploadedFiles.length === 0) {
    return NextResponse.json(
      { error: "No files were uploaded" },
      { status: 400 },
    );
  }

  try {
    const files = await saveImageUploads(currentDir, uploadedFiles);
    return NextResponse.json({ files }, { status: 201 });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to upload files";
    const status = message.includes("already exists") ? 409 : 400;

    return NextResponse.json({ error: message }, { status });
  }
}
