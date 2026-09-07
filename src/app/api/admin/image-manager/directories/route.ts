import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import { revalidatePublicSite } from "@/lib/public-content-revalidation";
import fs from "fs/promises";
import path from "path";
import {
  IMAGES_ROOT,
  ensureImagesRootForRead,
  isSafeDirectoryName,
  isStorageUnavailableCode,
  resolveInImagesRoot,
  storageUnavailableMessage,
} from "@/lib/image-storage";

/**
 * Read one string field from a parsed JSON body, or "" when it is missing or not
 * a string. Extracted in #2841: five call sites below repeated the same
 * seven-line narrowing, and that repetition is what put this file over its size
 * budget once the path-containment reasoning was written down. `trim` is
 * per-field on purpose — a directory name is trimmed, a path is not.
 */
function readStringField(
  body: unknown,
  field: string,
  options: { trim?: boolean } = {},
): string {
  if (body === null || typeof body !== "object" || !(field in body)) return "";
  const value = (body as Record<string, unknown>)[field];
  if (typeof value !== "string") return "";
  return options.trim ? value.trim() : value;
}

async function collectDirs(absDir: string, relBase: string): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(absDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const result: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
      result.push(rel);
      // absDir is contained under IMAGES_ROOT; entry.name comes from readdir of
      // that directory, not from request input. #2841 triage:
      // docs/SECURITY-ATTACK-SURFACE.md -> "Image Manager path containment".
      const children = await collectDirs(path.join(absDir, entry.name), rel);
      result.push(...children);
    }
  }
  return result;
}

// GET /api/admin/image-manager/directories – list all directories
export async function GET() {
  const guard = await requireAdmin({
    permission: { area: "content", level: "view" },
  });
  if (!guard.ok) return guard.response;

  await ensureImagesRootForRead();
  const dirs = await collectDirs(IMAGES_ROOT, "");
  return NextResponse.json({ directories: ["", ...dirs] });
}

// POST /api/admin/image-manager/directories – create a new directory
export async function POST(request: NextRequest) {
  const guard = await requireAdmin({
    permission: { area: "content", level: "edit" },
  });
  if (!guard.ok) return guard.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const name = readStringField(body, "name", { trim: true });
  const parent = readStringField(body, "parent");

  if (!isSafeDirectoryName(name)) {
    return NextResponse.json(
      { error: "Invalid directory name" },
      { status: 400 },
    );
  }

  const parentAbs = resolveInImagesRoot(parent);
  if (!parentAbs) {
    return NextResponse.json({ error: "Invalid parent path" }, { status: 400 });
  }

  // parentAbs is resolveInImagesRoot-contained and `name` passed
  // isSafeDirectoryName above; the check below re-confirms containment before
  // mkdir. Why that is enough, and the whole #2841 triage behind it:
  // docs/SECURITY-ATTACK-SURFACE.md -> "Image Manager path containment".
  const newAbs = path.join(parentAbs, name);
  // Strict: a directory being CREATED is always a child, never the root itself.
  // A `newAbs !== IMAGES_ROOT &&` escape hatch here is what let `name: ".."`
  // reach mkdir (#2841) — do not restore it.
  if (!newAbs.startsWith(IMAGES_ROOT + path.sep)) {
    return NextResponse.json({ error: "Invalid path" }, { status: 400 });
  }

  try {
    // Non-recursive: a pre-existing directory throws EEXIST -> 409. The mkdir
    // stays inline here (right after the containment check above) so the
    // path-traversal barrier is local. The images root and parent already exist
    // (GET ensures the root; the UI only creates inside an existing directory).
    await fs.mkdir(newAbs);
    // Every write to the images tree clears the stored public pages (#2352 slice-1
    // review): the photo-gallery embeds resolve their file list with an `fs.readdir`
    // at render time, so that listing is frozen into a stored page. A rename or a
    // recursive delete changes what a `{{photo-gallery:<dir>}}` token resolves to
    // just as much as an upload does.
    revalidatePublicSite();
    return NextResponse.json({ ok: true });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "EEXIST") {
      return NextResponse.json(
        { error: "Directory already exists" },
        { status: 409 },
      );
    }
    // Path passed as a separate argument so a tainted value cannot act as a
    // format directive.
    console.error(
      "image-manager: failed to create directory:",
      newAbs,
      e.code,
      e.message,
    );
    // A missing/read-only storage volume gets the clear, actionable message;
    // anything else is an opaque failure.
    if (isStorageUnavailableCode(e.code)) {
      return NextResponse.json(
        { error: storageUnavailableMessage(e.code) },
        { status: 500 },
      );
    }
    return NextResponse.json(
      { error: "Failed to create directory" },
      { status: 500 },
    );
  }
}

// PATCH /api/admin/image-manager/directories – rename a directory
export async function PATCH(request: NextRequest) {
  const guard = await requireAdmin({
    permission: { area: "content", level: "edit" },
  });
  if (!guard.ok) return guard.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const rel = readStringField(body, "path");
  const newName = readStringField(body, "newName", { trim: true });

  if (!rel) {
    return NextResponse.json(
      { error: "Cannot rename the root directory" },
      { status: 400 },
    );
  }
  if (!isSafeDirectoryName(newName)) {
    return NextResponse.json(
      { error: "Invalid directory name" },
      { status: 400 },
    );
  }

  const oldAbs = resolveInImagesRoot(rel);
  if (!oldAbs || oldAbs === IMAGES_ROOT) {
    return NextResponse.json({ error: "Invalid path" }, { status: 400 });
  }

  // oldAbs is resolveInImagesRoot-contained and `newName` passed
  // isSafeDirectoryName above; the check below re-confirms containment before
  // rename. #2841 triage: docs/SECURITY-ATTACK-SURFACE.md -> "Image Manager
  // path containment".
  const newAbs = path.join(path.dirname(oldAbs), newName);
  if (!newAbs.startsWith(IMAGES_ROOT + path.sep)) {
    return NextResponse.json(
      { error: "Invalid rename target" },
      { status: 400 },
    );
  }

  try {
    await fs.rename(oldAbs, newAbs);
    revalidatePublicSite();
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json(
      { error: "Failed to rename directory" },
      { status: 500 },
    );
  }
}

// DELETE /api/admin/image-manager/directories – delete a directory and its contents
export async function DELETE(request: NextRequest) {
  const guard = await requireAdmin({
    permission: { area: "content", level: "edit" },
  });
  if (!guard.ok) return guard.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const rel = readStringField(body, "path");

  if (!rel) {
    return NextResponse.json(
      { error: "Cannot delete the root directory" },
      { status: 400 },
    );
  }

  const absPath = resolveInImagesRoot(rel);
  if (!absPath || absPath === IMAGES_ROOT) {
    return NextResponse.json({ error: "Invalid path" }, { status: 400 });
  }

  try {
    await fs.rm(absPath, { recursive: true });
    revalidatePublicSite();
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json(
      { error: "Failed to delete directory" },
      { status: 500 },
    );
  }
}
