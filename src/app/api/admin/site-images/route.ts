import { promises as fs } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import { connectionJson } from "@/lib/mcp-connection-request";
import { SITE_IMAGES_CONNECTION_SHAPE } from "@/lib/connection-shapes/content-images";

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
  permission: { area: "content", level: "view" },
} as const;

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

export async function GET(request: Request) {
  const guard = await requireAdmin(adminGuardOptions);
  if (!guard.ok) {
    return guard.response;
  }

  try {
    const imagesDir = path.join(process.cwd(), "public", SITE_IMAGES_DIR);
    const images = await listImagesRecursively(imagesDir);
    images.sort((a, b) => a.localeCompare(b));

    return connectionJson(
      request,
      { images: images.map((webPath) => `/${SITE_IMAGES_DIR}${webPath}`) },
      SITE_IMAGES_CONNECTION_SHAPE,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return connectionJson(request, { images: [] }, SITE_IMAGES_CONNECTION_SHAPE);
    }
    console.error("Failed to list site images", error);
    return NextResponse.json(
      { error: "Failed to list site images" },
      { status: 500 },
    );
  }
}
