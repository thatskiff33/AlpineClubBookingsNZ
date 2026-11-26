/**
 * The public image routes' request schemas, shared with the AI app actions
 * that call them (ALP-723, `INV-SSOT`): the Image Manager's folders and photos
 * (`/api/admin/image-manager/**`, the files the `{{photo-gallery:<folder>}}`
 * token shows) and the image library list (`/api/admin/image-library`, the
 * images a page embeds). Uploading stays on the website.
 *
 * Folder paths are relative to the images root, "" being the root. The schemas
 * only check that each field is text: whether it is empty, a name is safe or a path stays
 * inside the root is decided by the route (`image-storage.ts`).
 */
import { z } from "zod";

/** A folder path relative to the images root; left out or "" is the root. */
const folderPath = z.string().optional().default("");

/** `GET /api/admin/image-manager/images`. */
export const imageManagerListQuerySchema = z.object({
  dir: folderPath,
});

/** `DELETE /api/admin/image-manager/images`: one photo and its website-sized copies. */
export const imageManagerDeleteImageSchema = z.object({
  dir: folderPath,
  filename: z.string(),
});

/** `POST /api/admin/image-manager/directories`: a new folder inside `parent`. */
export const imageManagerCreateFolderSchema = z.object({
  name: z.string().trim(),
  parent: folderPath,
});

/** `PATCH /api/admin/image-manager/directories`: renames the folder at `path` in place. */
export const imageManagerRenameFolderSchema = z.object({
  path: z.string(),
  newName: z.string().trim(),
});

/** `DELETE /api/admin/image-manager/directories`: the folder at `path` and everything in it. */
export const imageManagerDeleteFolderSchema = z.object({
  path: z.string(),
});

/** `GET /api/admin/image-library`. */
export const imageLibraryListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(24),
});
