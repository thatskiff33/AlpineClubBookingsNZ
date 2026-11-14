import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import path from "path";
import { NextRequest } from "next/server";

import { GET } from "@/app/api/images/uploaded/[...path]/route";
import { IMAGES_ROOT, IMAGE_DERIVATIVES_DIRECTORY } from "@/lib/image-storage";

// #4935: the uploaded-image route streams the file and answers a revalidation
// with a body-less 304. Real files under a unique folder of the real
// (gitignored) images root, removed afterwards.

const folder = `vitest-uploaded-${process.pid}`;
const absDir = path.join(IMAGES_ROOT, folder);
const BYTES = Buffer.from("\x89PNG pretend image bytes");

function get(
  parts: string[],
  headers: Record<string, string> = {},
  method: "GET" | "HEAD" = "GET",
) {
  return GET(
    new NextRequest(`http://localhost/api/images/uploaded/${parts.join("/")}`, {
      headers,
      method,
    }),
    { params: Promise.resolve({ path: parts }) },
  );
}

beforeEach(async () => {
  await fs.mkdir(absDir, { recursive: true });
  await fs.writeFile(path.join(absDir, "hut.png"), BYTES);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(absDir, { recursive: true, force: true });
});

describe("GET /api/images/uploaded/[...path]", () => {
  it("streams the file with its type, length and both validators — never reading it whole", async () => {
    const readFile = vi.spyOn(fs, "readFile");
    const open = vi.spyOn(fs, "open");
    const response = await get([folder, "hut.png"]);
    expect(open).toHaveBeenCalledTimes(1); // the spies see the route's own fs

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(response.headers.get("Content-Length")).toBe(String(BYTES.length));
    expect(response.headers.get("ETag")).toMatch(/^"[0-9a-f]{32}"$/);
    const { mtime } = await fs.stat(path.join(absDir, "hut.png"));
    expect(response.headers.get("Last-Modified")).toBe(mtime.toUTCString());
    // Names are reused (an officer replaces lodge.jpg), so never immutable.
    expect(response.headers.get("Cache-Control")).toBe(
      "public, max-age=300, must-revalidate",
    );
    expect(Buffer.from(await response.arrayBuffer())).toEqual(BYTES);
    expect(readFile).not.toHaveBeenCalled();
  });

  // #5087 review: Next runs GET for a HEAD request and then ends the response
  // without reading the body, so a stream opened for HEAD would hold its file
  // handle until garbage collection.
  it("answers HEAD with the headers, no body, and the file handle closed", async () => {
    const realOpen = fs.open.bind(fs);
    let close: ReturnType<typeof vi.fn> | undefined;
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await realOpen(...(args as Parameters<typeof fs.open>));
      close = vi.spyOn(handle, "close") as unknown as ReturnType<typeof vi.fn>;
      return handle;
    });

    const response = await get([folder, "hut.png"], {}, "HEAD");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(response.headers.get("Content-Length")).toBe(String(BYTES.length));
    expect(response.headers.get("ETag")).toMatch(/^"[0-9a-f]{32}"$/);
    expect(response.body).toBeNull();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("answers 304 with no body when If-None-Match carries the current tag", async () => {
    const etag = (await get([folder, "hut.png"])).headers.get("ETag")!;
    const response = await get([folder, "hut.png"], { "If-None-Match": etag });
    expect(response.status).toBe(304);
    expect(response.headers.get("ETag")).toBe(etag);
    expect(response.body).toBeNull();

    const weak = await get([folder, "hut.png"], { "If-None-Match": `"x", W/${etag}` });
    expect(weak.status).toBe(304);
  });

  it("answers 304 to If-Modified-Since only when the file is no newer", async () => {
    const { mtime } = await fs.stat(path.join(absDir, "hut.png"));
    const same = await get([folder, "hut.png"], {
      "If-Modified-Since": mtime.toUTCString(),
    });
    expect(same.status).toBe(304);

    const earlier = new Date(mtime.getTime() - 10_000).toUTCString();
    const older = await get([folder, "hut.png"], { "If-Modified-Since": earlier });
    expect(older.status).toBe(200);
    await older.arrayBuffer();

    // If-None-Match wins: a stale tag means a full response whatever the date.
    const stale = await get([folder, "hut.png"], {
      "If-None-Match": '"stale"',
      "If-Modified-Since": mtime.toUTCString(),
    });
    expect(stale.status).toBe(200);
    await stale.arrayBuffer();
  });

  it("gives a replaced file a new tag, so the old one no longer validates", async () => {
    const first = await get([folder, "hut.png"]);
    const etag = first.headers.get("ETag")!;
    await first.arrayBuffer();

    // Replaced the way the upload route does it: a new file renamed over it.
    const temporary = path.join(absDir, ".hut.png.part");
    await fs.writeFile(temporary, Buffer.from("a different, longer photo body"));
    await fs.rename(temporary, path.join(absDir, "hut.png"));

    const response = await get([folder, "hut.png"], { "If-None-Match": etag });
    expect(response.status).toBe(200);
    expect(response.headers.get("ETag")).not.toBe(etag);
    expect(await response.text()).toBe("a different, longer photo body");
  });

  it("serves a website-sized copy from the copies folder", async () => {
    await fs.mkdir(path.join(absDir, IMAGE_DERIVATIVES_DIRECTORY));
    await fs.writeFile(
      path.join(absDir, IMAGE_DERIVATIVES_DIRECTORY, "hut.png.400.webp"),
      BYTES,
    );
    const response = await get([folder, IMAGE_DERIVATIVES_DIRECTORY, "hut.png.400.webp"]);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/webp");
    await response.arrayBuffer();
  });

  it.each([
    [["..", "..", "package.json"]],
    [[folder, "..", "..", "..", "etc", "passwd.png"]],
    [[folder, "missing.png"]],
    [[folder, "notes.txt"]],
    [[folder]],
    [[]],
  ])("answers 404 for %j", async (parts) => {
    const response = await get(parts);
    expect(response.status).toBe(404);
  });

  it("answers 404 for a directory named like an image", async () => {
    await fs.mkdir(path.join(absDir, "album.jpg"));
    expect((await get([folder, "album.jpg"])).status).toBe(404);
  });
});
