import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  mediaImageFindUnique: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    mediaImage: {
      findUnique: mocks.mediaImageFindUnique,
    },
  },
}));

import { GET } from "@/app/api/images/[id]/route";

function imageRequest(id: string, headers?: Record<string, string>) {
  return new NextRequest(`http://localhost/api/images/${id}`, { headers });
}

describe("GET /api/images/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 404 for an unknown id", async () => {
    mocks.mediaImageFindUnique.mockResolvedValue(null);

    const response = await GET(imageRequest("missing"), {
      params: Promise.resolve({ id: "missing" }),
    });

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toMatch(/not found/i);
  });

  it("streams the image bytes with caching and hardening headers", async () => {
    const data = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    mocks.mediaImageFindUnique.mockResolvedValue({
      data,
      contentType: "image/png",
    });

    const response = await GET(imageRequest("img-1"), {
      params: Promise.resolve({ id: "img-1" }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(response.headers.get("Cache-Control")).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(response.headers.get("ETag")).toBe('"img-1"');
    expect(response.headers.get("Content-Disposition")).toBe("inline");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Content-Security-Policy")).toBe(
      "default-src 'none'; style-src 'unsafe-inline'",
    );

    const buffer = Buffer.from(await response.arrayBuffer());
    expect(buffer.equals(data)).toBe(true);
  });

  it("returns 304 when If-None-Match matches the current ETag", async () => {
    mocks.mediaImageFindUnique.mockResolvedValue({
      data: Buffer.from("svg-bytes"),
      contentType: "image/svg+xml",
    });

    const response = await GET(
      imageRequest("img-2", { "if-none-match": '"img-2"' }),
      { params: Promise.resolve({ id: "img-2" }) },
    );

    expect(response.status).toBe(304);
    expect(response.headers.get("ETag")).toBe('"img-2"');
    const buffer = Buffer.from(await response.arrayBuffer());
    expect(buffer.length).toBe(0);
  });

  it("applies the same hardening headers to SVG responses", async () => {
    mocks.mediaImageFindUnique.mockResolvedValue({
      data: Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'></svg>"),
      contentType: "image/svg+xml",
    });

    const response = await GET(imageRequest("img-3"), {
      params: Promise.resolve({ id: "img-3" }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/svg+xml");
    expect(response.headers.get("Content-Disposition")).toBe("inline");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Content-Security-Policy")).toBe(
      "default-src 'none'; style-src 'unsafe-inline'",
    );
  });
});
