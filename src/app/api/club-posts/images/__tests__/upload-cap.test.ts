import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * #3091 review 3: the six-image cap is ENFORCED at upload, not merely
 * advertised in the response. Scoped to this one guard — the storage
 * pipeline, sniffing and re-encoding have their own suites.
 */

const mocks = vi.hoisted(() => ({
  loadEffectiveModuleFlags: vi.fn(),
  requireActiveSession: vi.fn(),
  applyMemberScopedRateLimit: vi.fn<() => Promise<Response | null>>(
    async () => null,
  ),
  imageCount: vi.fn(),
  imageCreate: vi.fn(),
  ensurePostImageDirectory: vi.fn(),
  writePostImage: vi.fn(),
  logAudit: vi.fn(),
}));

vi.mock("@/lib/module-settings", () => ({
  loadEffectiveModuleFlags: mocks.loadEffectiveModuleFlags,
}));
vi.mock("@/lib/session-guards", () => ({
  requireActiveSession: mocks.requireActiveSession,
}));
vi.mock("@/lib/rate-limit", () => ({
  applyMemberScopedRateLimit: mocks.applyMemberScopedRateLimit,
  rateLimiters: {
    clubPostImageUpload: { id: "club-post-image-upload", limit: 30, windowSeconds: 3600 },
  },
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    clubPostImage: { count: mocks.imageCount, create: mocks.imageCreate },
  },
}));
vi.mock("@/lib/post-image-storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/post-image-storage")>()),
  ensurePostImageDirectory: mocks.ensurePostImageDirectory,
  writePostImage: mocks.writePostImage,
}));
vi.mock("@/lib/audit", () => ({ logAudit: mocks.logAudit }));

import { POST } from "@/app/api/club-posts/images/route";
import { NextRequest } from "next/server";

function upload(): NextRequest {
  const form = new FormData();
  form.append("file", new File([new Uint8Array([1, 2, 3])], "photo.jpg"));
  return new NextRequest("https://club.test/api/club-posts/images", {
    method: "POST",
    body: form,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.loadEffectiveModuleFlags.mockResolvedValue({ commsPortal: true });
  mocks.requireActiveSession.mockResolvedValue({
    ok: true,
    session: { user: { id: "member-1" } },
  });
  mocks.applyMemberScopedRateLimit.mockResolvedValue(null);
  mocks.ensurePostImageDirectory.mockResolvedValue(undefined);
  mocks.writePostImage.mockResolvedValue({
    storageKey: "posts/2026/07/x.webp",
    publicId: "a".repeat(32),
    mimeType: "image/webp",
    sha256: "b".repeat(64),
    width: 10,
    height: 10,
    bytes: 3,
  });
  mocks.imageCreate.mockResolvedValue({
    publicId: "a".repeat(32),
    width: 10,
    height: 10,
  });
});

describe("the six-image cap at upload (#3091 r3)", () => {
  it("refuses a seventh unclaimed upload with the reason in words", async () => {
    mocks.imageCount.mockResolvedValue(6);

    const res = await POST(upload());

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("at most 6 images");
    expect(mocks.writePostImage).not.toHaveBeenCalled();
  });

  it("counts only the member's OWN unclaimed uploads", async () => {
    mocks.imageCount.mockResolvedValue(0);

    const res = await POST(upload());

    expect(res.status).toBe(201);
    expect(mocks.imageCount).toHaveBeenCalledWith({
      where: { uploadedByMemberId: "member-1", postId: null },
    });
  });
});
