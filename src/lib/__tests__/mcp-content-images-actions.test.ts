/**
 * ALP-723 (`INV-MCP-006`): the public image actions an officer's AI app
 * connection may run. Reads are held to their contract
 * (`expectActionContract`); a folder or photo change cannot run twice on the
 * same files, so it runs once, as a connection, on a request built from its
 * catalogue entry. The Image Manager works on real files under a unique
 * folder of the real (gitignored) images root, as its route tests do.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import path from "path";
import type { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));

const h = vi.hoisted(() => ({
  auth: vi.fn(),
  prisma: {
    mediaImage: { findMany: vi.fn(), count: vi.fn(), findFirst: vi.fn(), deleteMany: vi.fn() },
    pageContent: { findMany: vi.fn() },
  },
}));

vi.mock("@/lib/auth", () => ({ auth: h.auth }));
vi.mock("@/lib/session-guards", async () => ({
  requireAdmin: (await import("./helpers/require-admin-mock")).evaluateRequireAdminMock,
  requireActiveSessionUser: vi.fn(async () => null),
}));
vi.mock("@/lib/prisma", () => ({ prisma: h.prisma }));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }));
vi.mock("@/lib/public-content-revalidation", () => ({
  revalidatePublicSite: vi.fn(),
  revalidatePublicPageContent: vi.fn(),
}));

import * as directoriesRoute from "@/app/api/admin/image-manager/directories/route";
import * as imagesRoute from "@/app/api/admin/image-manager/images/route";
import { DELETE as deleteLibraryImage } from "@/app/api/admin/image-library/[id]/route";
import { GET as listLibraryImages } from "@/app/api/admin/image-library/route";
import { GET as listBrandingImages } from "@/app/api/admin/site-images/route";
import {
  buildActionRequest,
  expectActionContract,
  officerMemberSession,
} from "@/lib/__tests__/helpers/mcp-action-contract";
import { IMAGES_ROOT } from "@/lib/image-storage";
import { findMcpAction } from "@/lib/mcp/catalogue";

const folder = `vitest-mcp-content-${process.pid}`;
const absDir = path.join(IMAGES_ROOT, folder);

async function exists(p: string) {
  return fs.stat(p).then(
    () => true,
    () => false,
  );
}

/** Runs a change action once, as the dispatcher's connection call reaches it, and checks its answer's fields. */
async function runAsConnection(
  actionId: string,
  handler: (request: NextRequest) => Promise<Response>,
  args: Record<string, unknown>,
) {
  const action = findMcpAction(actionId)!;
  const { request } = buildActionRequest(action, args, true);
  const response = await handler(request as NextRequest);
  expect(response.status, actionId).toBe(200);
  const answer = (await response.json()) as Record<string, unknown>;
  expect(Object.keys(answer).sort(), actionId).toEqual(Object.keys(action.returns).sort());
  return answer;
}

beforeEach(async () => {
  vi.clearAllMocks();
  h.auth.mockResolvedValue(officerMemberSession());
  await fs.mkdir(path.join(absDir, "album"), { recursive: true });
  await fs.writeFile(path.join(absDir, "album", "lodge.jpg"), "original");
});

afterEach(async () => {
  await fs.rm(absDir, { recursive: true, force: true });
});

describe("Image Manager actions", () => {
  it("list_image_folders and list_folder_photos read the folders and their photos", async () => {
    const folders = await expectActionContract({ actionId: "list_image_folders", handler: directoriesRoute.GET });
    expect((folders.connection as { directories: string[] }).directories).toContain(`${folder}/album`);

    const photos = await expectActionContract({
      actionId: "list_folder_photos",
      handler: imagesRoute.GET,
      args: { dir: `${folder}/album` },
    });
    expect(photos.connection).toEqual({
      images: [
        {
          filename: "lodge.jpg",
          url: `/api/images/uploaded/${folder}/album/lodge.jpg`,
          byteSize: 8,
          modifiedAt: expect.any(String),
        },
      ],
    });
  });

  it("create_image_folder, rename_image_folder and delete_image_folder change the folder named", async () => {
    await runAsConnection("create_image_folder", directoriesRoute.POST, { name: "winter", parent: folder });
    expect(await exists(path.join(absDir, "winter"))).toBe(true);

    await runAsConnection("rename_image_folder", directoriesRoute.PATCH, { path: `${folder}/winter`, newName: "spring" });
    expect(await exists(path.join(absDir, "spring"))).toBe(true);

    await runAsConnection("delete_image_folder", directoriesRoute.DELETE, { path: `${folder}/spring` });
    expect(await exists(path.join(absDir, "spring"))).toBe(false);
  });

  it("refuses a folder name or path that would leave the images root, from an app as from the browser", async () => {
    const action = findMcpAction("create_image_folder")!;
    const { request } = buildActionRequest(action, { name: "..", parent: folder }, true);
    expect((await directoriesRoute.POST(request as NextRequest)).status).toBe(400);

    const escape = buildActionRequest(findMcpAction("delete_image_folder")!, { path: "../.." }, true);
    expect((await directoriesRoute.DELETE(escape.request as NextRequest)).status).toBe(400);
    expect(await exists(IMAGES_ROOT)).toBe(true);
  });

  it("delete_folder_photo deletes the photo named", async () => {
    await runAsConnection("delete_folder_photo", imagesRoute.DELETE, { dir: `${folder}/album`, filename: "lodge.jpg" });
    expect(await exists(path.join(absDir, "album", "lodge.jpg"))).toBe(false);
  });
});

describe("image library and branding image actions", () => {
  const libraryRow = {
    id: "img-1",
    filename: "lodge.png",
    contentType: "image/png",
    byteSize: 1200,
    altText: "The lodge in winter",
    width: 800,
    height: 600,
    uploadedByMemberId: "officer-1",
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
  };

  it("list_library_images sends a page of content images, never members' photos", async () => {
    h.prisma.mediaImage.findMany.mockResolvedValue([libraryRow]);
    h.prisma.mediaImage.count.mockResolvedValue(1);

    const { connection } = await expectActionContract({
      actionId: "list_library_images",
      handler: listLibraryImages,
      args: { page: 1, pageSize: 10 },
    });

    expect(connection).toMatchObject({ images: [{ id: "img-1", url: "/api/images/img-1" }], total: 1, page: 1, pageSize: 10 });
    expect(h.prisma.mediaImage.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { kind: "CONTENT" } }));
  });

  it("delete_library_image deletes a content image and names the pages that still show it", async () => {
    h.prisma.mediaImage.findFirst.mockResolvedValue({ id: "img-1", filename: "lodge.png" });
    h.prisma.pageContent.findMany.mockResolvedValue([{ slug: "about" }]);

    const { connection } = await expectActionContract({
      actionId: "delete_library_image",
      handler: deleteLibraryImage,
      args: { id: "img-1" },
    });

    expect(connection).toEqual({ success: true, referencedBySlugs: ["about"] });
    expect(h.prisma.mediaImage.deleteMany).toHaveBeenCalledWith({ where: { id: "img-1", kind: "CONTENT" } });
  });

  it("list_branding_images lists the built-in images by address", async () => {
    const { connection } = await expectActionContract({ actionId: "list_branding_images", handler: listBrandingImages });

    const { images } = connection as { images: string[] };
    expect(images.length).toBeGreaterThan(0);
    expect(images.every((image) => image.startsWith("/branding/"))).toBe(true);
  });
});
