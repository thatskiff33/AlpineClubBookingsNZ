import { promises as fs } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";

const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  ".avif",
]);

// Only expose the deployed branding/content image folder to the picker,
// not the whole public/ tree. This endpoint lists repo-committed files
// only; there is no upload capability.
const SITE_IMAGES_DIR = "branding";

function unauthorizedResponse() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

const adminGuardOptions = {
  forbiddenResponse: unauthorizedResponse,
};

async function listImagesRecursively(
  baseDir: string,
  relativeDir = "",
): Promise<string[]> {
  const currentDir = path.join(baseDir, relativeDir);
  const entries = await fs.readdir(currentDir, { withFileTypes: true });
  const images: string[] = [];

  for (const entry of entries) {
    if (entry.name.startsWith(".")) {
      continue;
    }

    const entryRelativePath = relativeDir
      ? path.join(relativeDir, entry.name)
      : entry.name;

    if (entry.isDirectory()) {
      images.push(...(await listImagesRecursively(baseDir, entryRelativePath)));
      continue;
    }

    const ext = path.extname(entry.name).toLowerCase();
    if (!IMAGE_EXTENSIONS.has(ext)) {
      continue;
    }

    const webPath = `/${entryRelativePath.replace(/\\/g, "/")}`;
    images.push(webPath);
  }

  return images;
}

export async function GET() {
  const guard = await requireAdmin(adminGuardOptions);
  if (!guard.ok) {
    return guard.response;
  }

  try {
    const publicDir = path.join(process.cwd(), "public");
    const images = await listImagesRecursively(publicDir);
    images.sort((a, b) => a.localeCompare(b));

    return NextResponse.json({ images });
  } catch (error) {
    console.error("Failed to list site images", error);
    return NextResponse.json(
      { error: "Failed to list site images" },
      { status: 500 },
    );
  }
}
