import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import fs from "fs/promises";
import path from "path";
import {
  ALLOWED_IMAGE_EXTS,
  ensureImagesRootForRead,
  imagePublicUrl,
  resolveAlbumPathInImagesRoot,
  removeImageDerivatives,
} from "@/lib/image-storage";
import { revalidatePublicSite } from "@/lib/public-content-revalidation";

// GET /api/admin/image-manager/images?dir=<relative-path> – list images in a directory
export async function GET(request: NextRequest) {
  const guard = await requireAdmin({
    permission: { area: "content", level: "view" },
  });
  if (!guard.ok) return guard.response;

  const dir = request.nextUrl.searchParams.get("dir") ?? "";
  // The website-sized copies folder (#4935) is never listed: its files are
  // managed through their originals only.
  const absDir = resolveAlbumPathInImagesRoot(dir);
  if (!absDir) {
    return NextResponse.json({ error: "Invalid directory" }, { status: 400 });
  }

  await ensureImagesRootForRead();

  let entries;
  try {
    entries = await fs.readdir(absDir, { withFileTypes: true });
  } catch {
    return NextResponse.json({ images: [] });
  }

  const imageFiles = entries.filter(
    (e) => e.isFile() && ALLOWED_IMAGE_EXTS.has(path.extname(e.name).toLowerCase()),
  );

  const images = await Promise.all(
    imageFiles.map(async (e) => {
      // absDir is contained under IMAGES_ROOT; e.name comes from readdir of that
      // directory, not from request input. Justification and the #2841 triage:
      // docs/SECURITY-ATTACK-SURFACE.md -> "Image Manager path containment".
      const filePath = path.join(absDir, e.name);
      const stat = await fs.stat(filePath);
      return {
        filename: e.name,
        url: imagePublicUrl(filePath),
        byteSize: stat.size,
        modifiedAt: stat.mtime.toISOString(),
      };
    }),
  );

  // Sort alphabetically
  images.sort((a, b) => a.filename.localeCompare(b.filename));

  return NextResponse.json({ images });
}

// DELETE /api/admin/image-manager/images – delete a single image file
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

  // ONE read of each field, narrowed by `typeof`, rather than a `typeof` check
  // on one read and the value taken from a second read through a
  // `Record<string, string>` cast. Under stricter indexed access that cast's
  // own lookup is `string | undefined` — the compiler pointing out that the
  // two reads were never provably the same value (#2801). Net one cast fewer.
  const bodyFields: Record<string, unknown> =
    body !== null && typeof body === "object"
      ? (body as Record<string, unknown>)
      : {};
  const rawDir = bodyFields.dir;
  const rawFilename = bodyFields.filename;
  const dir = typeof rawDir === "string" ? rawDir : "";
  const filename = typeof rawFilename === "string" ? rawFilename : "";

  if (!filename || /[/\\]/.test(filename)) {
    return NextResponse.json({ error: "Invalid filename" }, { status: 400 });
  }

  const ext = path.extname(filename).toLowerCase();
  if (!ALLOWED_IMAGE_EXTS.has(ext)) {
    return NextResponse.json({ error: "Not an image file" }, { status: 400 });
  }

  const absDir = resolveAlbumPathInImagesRoot(dir);
  if (!absDir) {
    return NextResponse.json({ error: "Invalid directory" }, { status: 400 });
  }

  // absDir is resolveInImagesRoot-contained and filename is rejected above if it
  // contains a separator; the startsWith check below re-confirms containment.
  // Justification and the #2841 triage:
  // docs/SECURITY-ATTACK-SURFACE.md -> "Image Manager path containment".
  const filePath = path.join(absDir, filename);
  // Strict: the file being deleted is always a child of absDir, never absDir
  // itself. The dropped `filePath !== absDir &&` escape hatch was the same shape
  // as the one that let `name: ".."` through on the directories route (#2841).
  // It is not reachable here — the only names `path.join` treats as operators
  // are "." and "..", and measured, both give `path.extname` an empty string, so
  // the image-extension allowlist above has already rejected them — but a check
  // whose correctness rests on an allowlist two branches away is one refactor
  // from being wrong, and the strict form needs no such argument.
  if (!filePath.startsWith(absDir + path.sep)) {
    return NextResponse.json({ error: "Invalid path" }, { status: 400 });
  }

  try {
    await fs.unlink(filePath);
  } catch (err) {
    // Already gone is the outcome wanted, so a retry after "copies could not
    // be removed" goes on to try the copies again rather than failing here
    // (#5087 review). Any other error still fails before the copies are
    // touched.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      return NextResponse.json(
        { error: "Failed to delete image" },
        { status: 500 },
      );
    }
  }

  // Its website-sized copies go with it (#4935): a copy left behind would keep
  // the photo downloadable after the takedown. Attempted only once the
  // original is gone, and reported rather than swallowed if it fails.
  let copiesRemoved = true;
  try {
    await removeImageDerivatives(absDir, filename);
  } catch (err) {
    copiesRemoved = false;
    console.error(
      "image-manager: deleted an image but not its website copies:",
      filePath,
      (err as NodeJS.ErrnoException).code,
    );
  }

  // #2352 slice-1 review, and the DELETE case is the one that matters most: the
  // photo-gallery embeds resolve their file list SERVER-side, so a stored CMS page
  // kept rendering a deleted photo's URL — a broken image, and a takedown that was
  // not actually effective on the public page — until the 300-second backstop
  // lapsed. The gallery component has no failed-image fallback.
  revalidatePublicSite();
  if (!copiesRemoved) {
    return NextResponse.json(
      {
        error:
          "The image was deleted, but its resized website copies could not be removed. Check the image storage volume is writable by the app, then ask the operator to run the image backfill (images:backfill-sizes --apply) to remove them.",
      },
      { status: 500 },
    );
  }
  return NextResponse.json({ ok: true });
}
