/**
 * What the public image actions send an AI app connection (ALP-723,
 * `INV-MCP-006`): the Image Manager's folders and photos, the image library
 * that pages embed from, and the site's built-in branding images. Every
 * answer is already only names, addresses and sizes; no image bytes.
 */
import {
  completeConnectionShapeFor,
  type ConnectionShape,
} from "@/lib/connection-projection";

export const IMAGE_FOLDERS_CONNECTION_SHAPE = completeConnectionShapeFor<{ directories: string[] }>({
  directories: true,
});

/** A folder or photo change: `ok` once it is done. */
export const IMAGE_CHANGE_DONE_CONNECTION_SHAPE = completeConnectionShapeFor<{ ok: boolean }>({ ok: true });

interface ImageManagerPhoto {
  filename: string;
  url: string;
  byteSize: number;
  modifiedAt: string;
}

export const IMAGE_MANAGER_PHOTOS_CONNECTION_SHAPE = completeConnectionShapeFor<{ images: ImageManagerPhoto[] }>({
  images: { filename: true, url: true, byteSize: true, modifiedAt: true },
});

interface LibraryImage {
  id: string;
  filename: string;
  contentType: string;
  byteSize: number;
  altText: string | null;
  width: number | null;
  height: number | null;
  uploadedByMemberId: string | null;
  createdAt: string;
  url: string;
}

export const IMAGE_LIBRARY_LIST_CONNECTION_SHAPE = completeConnectionShapeFor<{
  images: LibraryImage[];
  total: number;
  page: number;
  pageSize: number;
}>({
  images: {
    id: true,
    filename: true,
    contentType: true,
    byteSize: true,
    altText: true,
    width: true,
    height: true,
    uploadedByMemberId: true,
    createdAt: true,
    url: true,
  },
  total: true,
  page: true,
  pageSize: true,
});

/** `referencedBySlugs`: pages whose HTML still shows the deleted image. */
export const IMAGE_LIBRARY_DELETED_CONNECTION_SHAPE = completeConnectionShapeFor<{
  success: boolean;
  referencedBySlugs: string[];
}>({ success: true, referencedBySlugs: true });

export const SITE_IMAGES_CONNECTION_SHAPE: ConnectionShape = completeConnectionShapeFor<{ images: string[] }>({
  images: true,
});
