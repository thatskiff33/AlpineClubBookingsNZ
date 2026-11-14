import fs, { type FileHandle } from "fs/promises";
import path from "path";
import { Readable } from "stream";
import { NextRequest, NextResponse } from "next/server";
import {
  ALLOWED_IMAGE_EXTS,
  imageContentTypeForExt,
  resolveInImagesRoot,
} from "@/lib/image-storage";
import { isNotModified, opaqueEtag } from "@/lib/http-validators";

export const runtime = "nodejs";

// File names are reused — an officer replaces `lodge.jpg` in place — so this
// is never `immutable` or long-lived (#4935). A short max-age plus validators
// makes the revalidation after it a body-less 304 instead of a full download.
const CACHE_CONTROL = "public, max-age=300, must-revalidate";

function notFound() {
  return NextResponse.json({ error: "Not found" }, { status: 404 });
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ path?: string[] }> },
) {
  const params = await context.params;
  const parts = params.path ?? [];

  if (!parts.length) {
    return notFound();
  }

  const relPath = parts.join("/");
  const ext = path.extname(relPath).toLowerCase();
  if (!ALLOWED_IMAGE_EXTS.has(ext)) {
    return notFound();
  }

  const absPath = resolveInImagesRoot(relPath);
  if (!absPath) {
    return notFound();
  }

  let handle: FileHandle;
  try {
    handle = await fs.open(absPath, "r");
  } catch {
    return notFound();
  }

  // Everything below describes the OPEN file, not the path: the size and
  // modification time come from the handle, and the body streams from it. An
  // upload replaces a file by rename, so a replacement mid-response leaves this
  // handle on the old bytes and the Content-Length below stays true.
  let stat;
  try {
    stat = await handle.stat();
  } catch {
    await handle.close();
    return notFound();
  }
  if (!stat.isFile()) {
    await handle.close();
    return notFound();
  }

  // Size, modification time and inode, digested: a replaced file always gets a
  // new tag, and no filesystem detail reaches the client.
  const etag = opaqueEtag(`${stat.size}:${stat.mtimeMs}:${stat.ino}`);
  const lastModified = stat.mtime;
  const validatorHeaders = {
    "Cache-Control": CACHE_CONTROL,
    ETag: etag,
    "Last-Modified": lastModified.toUTCString(),
  };

  if (isNotModified(request.headers, { etag, lastModified })) {
    await handle.close();
    return new NextResponse(null, { status: 304, headers: validatorHeaders });
  }

  const contentHeaders = {
    ...validatorHeaders,
    "Content-Type": imageContentTypeForExt(ext) ?? "application/octet-stream",
    "Content-Length": String(stat.size),
  };

  // Next answers HEAD by calling this GET and then ending the response without
  // reading or cancelling its body. A stream opened here would hold the file
  // handle (and its first buffered chunk) until garbage collection, one per
  // anonymous HEAD request. So HEAD gets the headers and no stream (#5087).
  if (request.method === "HEAD") {
    await handle.close();
    return new NextResponse(null, { status: 200, headers: contentHeaders });
  }

  // A zero-byte file has no valid `end` offset; it still gets an empty 200.
  const body =
    stat.size === 0
      ? null
      : (Readable.toWeb(
          // autoClose (the default) closes the handle when the stream ends,
          // errors or is destroyed by a client that goes away.
          handle.createReadStream({ start: 0, end: stat.size - 1 }),
        ) as ReadableStream<Uint8Array>);
  if (body === null) {
    await handle.close();
  }

  return new NextResponse(body, { status: 200, headers: contentHeaders });
}
