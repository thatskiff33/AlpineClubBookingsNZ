/**
 * Public images (Content admin area, ALP-723): the Image Manager's folders and
 * photos, which `{{photo-gallery:<folder>}}` shows on a page, the image
 * library pages embed from, and the site's built-in branding images. Uploading
 * a file stays on the website (`needs-browser` in `exclusions.ts`). Renaming
 * or deleting changes what public pages show at once, so each is
 * `destructive`; only adding an empty folder is a `write`.
 */
import {
  imageLibraryListQuerySchema,
  imageManagerCreateFolderSchema,
  imageManagerDeleteFolderSchema,
  imageManagerDeleteImageSchema,
  imageManagerListQuerySchema,
  imageManagerRenameFolderSchema,
} from "@/lib/admin-content-api/images";
import {
  IMAGE_CHANGE_DONE_CONNECTION_SHAPE,
  IMAGE_FOLDERS_CONNECTION_SHAPE,
  IMAGE_LIBRARY_DELETED_CONNECTION_SHAPE,
  IMAGE_LIBRARY_LIST_CONNECTION_SHAPE,
  IMAGE_MANAGER_PHOTOS_CONNECTION_SHAPE,
  SITE_IMAGES_CONNECTION_SHAPE,
} from "@/lib/connection-shapes/content-images";
import { routeIdParamsSchema } from "@/lib/route-id-params";

import type { McpAction } from "../catalogue";

export const CONTENT_IMAGE_MCP_ACTIONS: readonly McpAction[] = [
  // --- Image Manager (photo gallery folders) -----------------------------------
  {
    id: "list_image_folders",
    title: "List photo folders",
    summary:
      'Every folder in the Image Manager, as a path from the top ("" is the top folder itself). A page shows a folder\'s photos with `{{photo-gallery:<folder>}}`.',
    method: "GET",
    path: "/api/admin/image-manager/directories",
    kind: "read",
    returns: IMAGE_FOLDERS_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "create_image_folder",
    title: "Add a photo folder",
    summary:
      'Adds an empty folder called `name` inside `parent` (a path from `list_image_folders`; "" or left out is the top folder). Photos are uploaded into it on the website.',
    method: "POST",
    path: "/api/admin/image-manager/directories",
    body: imageManagerCreateFolderSchema,
    kind: "write",
    returns: IMAGE_CHANGE_DONE_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "rename_image_folder",
    title: "Rename a photo folder",
    summary:
      "Renames the folder at `path` to `newName`, in the same place. A page gallery that names the old folder shows nothing until it is edited to the new name.",
    method: "PATCH",
    path: "/api/admin/image-manager/directories",
    body: imageManagerRenameFolderSchema,
    kind: "destructive",
    returns: IMAGE_CHANGE_DONE_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "delete_image_folder",
    title: "Delete a photo folder",
    summary:
      "Deletes the folder at `path` with every photo and folder inside it, and takes them off any page gallery. This cannot be undone.",
    method: "DELETE",
    path: "/api/admin/image-manager/directories",
    body: imageManagerDeleteFolderSchema,
    kind: "destructive",
    returns: IMAGE_CHANGE_DONE_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "list_folder_photos",
    title: "List the photos in a folder",
    summary:
      'The photos in one Image Manager folder (`dir`, a path from `list_image_folders`; "" or left out is the top folder), with each one\'s public address and size.',
    method: "GET",
    path: "/api/admin/image-manager/images",
    query: imageManagerListQuerySchema,
    kind: "read",
    returns: IMAGE_MANAGER_PHOTOS_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "delete_folder_photo",
    title: "Delete a photo from a folder",
    summary:
      "Deletes one photo (`filename` in folder `dir`) and its website-sized copies, and takes it off any page gallery. This cannot be undone.",
    method: "DELETE",
    path: "/api/admin/image-manager/images",
    body: imageManagerDeleteImageSchema,
    kind: "destructive",
    returns: IMAGE_CHANGE_DONE_CONNECTION_SHAPE,
    core: false,
  },

  // --- Image library (images embedded in pages) --------------------------------
  {
    id: "list_library_images",
    title: "List the image library",
    summary:
      "The images uploaded for use in pages, newest first, a page at a time, with each one's address (`url`, for an `<img>` in page HTML), alt text and size. Members' profile photos are never listed.",
    method: "GET",
    path: "/api/admin/image-library",
    query: imageLibraryListQuerySchema,
    kind: "read",
    returns: IMAGE_LIBRARY_LIST_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "delete_library_image",
    title: "Delete an image from the library",
    summary:
      "Deletes one library image. A page that still shows it is left with a broken image; the answer lists those pages (`referencedBySlugs`) so they can be edited. This cannot be undone.",
    method: "DELETE",
    path: "/api/admin/image-library/[id]",
    params: routeIdParamsSchema,
    kind: "destructive",
    returns: IMAGE_LIBRARY_DELETED_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "list_branding_images",
    title: "List the site's built-in images",
    summary: "The branding images that ship with the website, by address, for use in page HTML.",
    method: "GET",
    path: "/api/admin/site-images",
    kind: "read",
    returns: SITE_IMAGES_CONNECTION_SHAPE,
    core: false,
  },
];
