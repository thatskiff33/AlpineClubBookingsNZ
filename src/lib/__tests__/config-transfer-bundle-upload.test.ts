import { describe, expect, it, vi } from "vitest";

// route-helpers.ts imports the full-admin gate (session-guards → next-auth),
// which does not resolve in the Vitest node environment. readBundleUpload itself
// touches neither, so stub the auth chain to let the module load.
vi.mock("@/lib/session-guards", () => ({ requireAdmin: vi.fn() }));
vi.mock("@/lib/access-roles", () => ({ isFullAdmin: vi.fn() }));

import { readBundleUpload } from "@/lib/config-transfer/route-helpers";
import {
  MAX_BUNDLE_BYTES,
  MAX_BUNDLE_REQUEST_BYTES,
} from "@/lib/config-transfer/bundle";

// `server-only` is stubbed globally in vitest.setup.ts. readBundleUpload takes a
// plain Request and does not touch the DB or auth (the full-admin gate is a
// separate helper), so these exercise only the streamed multipart reader wiring.

const BOUNDARY = "----bundleUploadTestBoundary";
const CT = `multipart/form-data; boundary=${BOUNDARY}`;

function buildBundleMultipart(fileBytes: Buffer, mode = "merge"): Buffer {
  const parts = [
    Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="mode"\r\n\r\n${mode}\r\n`,
      "utf8",
    ),
    Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="bundle"; filename="bundle.zip"\r\nContent-Type: application/zip\r\n\r\n`,
      "utf8",
    ),
    fileBytes,
    Buffer.from(`\r\n--${BOUNDARY}--\r\n`, "utf8"),
  ];
  return Buffer.concat(parts);
}

/** Build a bundle multipart body with an extra named form field appended. */
function buildBundleMultipartWithField(
  fileBytes: Buffer,
  field: { name: string; value: string },
  mode = "merge",
): Buffer {
  const parts = [
    Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="mode"\r\n\r\n${mode}\r\n`,
      "utf8",
    ),
    Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${field.name}"\r\n\r\n`,
      "utf8",
    ),
    Buffer.from(field.value, "utf8"),
    Buffer.from(
      `\r\n--${BOUNDARY}\r\nContent-Disposition: form-data; name="bundle"; filename="bundle.zip"\r\nContent-Type: application/zip\r\n\r\n`,
      "utf8",
    ),
    fileBytes,
    Buffer.from(`\r\n--${BOUNDARY}--\r\n`, "utf8"),
  ];
  return Buffer.concat(parts);
}

function bufferedRequest(body: Buffer) {
  return new Request("http://localhost/api/admin/config-transfer/plan", {
    method: "POST",
    headers: { "content-type": CT },
    body: new Uint8Array(body),
  });
}

/** Streamed request with an optional spoofed Content-Length. */
function streamedRequest(body: Buffer, contentLength?: string) {
  let offset = 0;
  const stream = new ReadableStream({
    pull(controller) {
      if (offset >= body.length) {
        controller.close();
        return;
      }
      const end = Math.min(offset + 256 * 1024, body.length);
      controller.enqueue(new Uint8Array(body.subarray(offset, end)));
      offset = end;
    },
  });
  const headers: Record<string, string> = { "content-type": CT };
  if (contentLength !== undefined) headers["content-length"] = contentLength;
  return new Request("http://localhost/api/admin/config-transfer/plan", {
    method: "POST",
    headers,
    body: stream,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

describe("readBundleUpload — streamed multipart cap (#2235)", () => {
  it("reads a valid bundle upload into bytes + mode", async () => {
    const fileBytes = Buffer.from("PK\x03\x04 pretend zip bytes", "latin1");
    const result = await readBundleUpload(
      bufferedRequest(buildBundleMultipart(fileBytes, "overwrite")),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.upload.mode).toBe("overwrite");
    expect(Buffer.from(result.upload.bytes).equals(fileBytes)).toBe(true);
  });

  it("rejects an over-cap bundle file with 413 (per-file streamed cap)", async () => {
    const fileBytes = Buffer.alloc(MAX_BUNDLE_BYTES + 1024, 0x61);
    const result = await readBundleUpload(
      bufferedRequest(buildBundleMultipart(fileBytes)),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(413);
  });

  it("accepts a bundle file of EXACTLY the cap (inclusive boundary, #2235 off-by-one guard)", async () => {
    // busboy trips its file limit at `size === cap`; the streamed reader passes
    // `cap + 1` so a bundle of exactly MAX_BUNDLE_BYTES still reads, matching the
    // route's own `file.size > MAX_BUNDLE_BYTES` (strictly greater) check.
    const fileBytes = Buffer.alloc(MAX_BUNDLE_BYTES, 0x61);
    expect(fileBytes.length).toBe(MAX_BUNDLE_BYTES);
    const result = await readBundleUpload(
      bufferedRequest(buildBundleMultipart(fileBytes)),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.upload.bytes.length).toBe(MAX_BUNDLE_BYTES);
  });

  it("accepts a large resolutions field over the old 1 MiB field default (field cap raised to 2 MiB, #2235)", async () => {
    // A bundle carrying many match-conflict resolutions produces a resolutions
    // JSON larger than the reader's 1 MiB default. Before the fix that 413'd as
    // the misleading "Bundle is too large."; the 2 MiB field cap now admits it.
    const resolutions = Array.from({ length: 2500 }, (_, i) => ({
      entity: "e",
      key: `k${"x".repeat(500)}-${i}`,
      matchId: "m",
    }));
    const json = JSON.stringify(resolutions);
    expect(json.length).toBeGreaterThan(1024 * 1024); // > old 1 MiB default
    expect(json.length).toBeLessThan(2 * 1024 * 1024); // < new 2 MiB field cap

    const fileBytes = Buffer.from("PK pretend zip bytes", "latin1");
    const result = await readBundleUpload(
      bufferedRequest(
        buildBundleMultipartWithField(fileBytes, {
          name: "resolutions",
          value: json,
        }),
      ),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.upload.resolutions).toHaveLength(2500);
  });

  it("rejects oversize form fields (> 2 MiB) with a distinct 413 (not 'Bundle is too large')", async () => {
    // A form field past the 2 MiB field cap trips cause \"field\", which the route
    // messages distinctly so the admin isn't told the (small) bundle FILE was too
    // big when it was the accompanying form data that overflowed.
    const hugeField = "z".repeat(2 * 1024 * 1024 + 16);
    const fileBytes = Buffer.from("PK pretend zip bytes", "latin1");
    const result = await readBundleUpload(
      bufferedRequest(
        buildBundleMultipartWithField(fileBytes, {
          name: "resolutions",
          value: hugeField,
        }),
      ),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(413);
    const body = await result.response.json();
    expect(body.error).toBe("Upload form fields are too large.");
  });

  it("rejects a chunked, spoofed-Content-Length over-cap body with 413", async () => {
    // Body larger than the whole-request cap, but declaring a tiny length that
    // would have skipped any naive Content-Length pre-check.
    const fileBytes = Buffer.alloc(MAX_BUNDLE_REQUEST_BYTES + 1024, 0x61);
    const result = await readBundleUpload(
      streamedRequest(buildBundleMultipart(fileBytes), "1024"),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(413);
  });

  it("rejects a non-multipart body as unreadable (400)", async () => {
    const request = new Request(
      "http://localhost/api/admin/config-transfer/plan",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ not: "multipart" }),
      },
    );
    const result = await readBundleUpload(request);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(400);
  });
});
