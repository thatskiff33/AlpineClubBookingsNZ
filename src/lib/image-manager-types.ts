export const IMAGE_MANAGER_ROOT_LABEL = "public/images";

export type ImageManagerBreadcrumb = {
  label: string;
  relativeDir: string;
};

export type ImageManagerDirectoryEntry = {
  name: string;
  relativeDir: string;
  webPath: string;
  modifiedAt: string;
};

export type ImageManagerFileEntry = {
  name: string;
  relativeDir: string;
  webPath: string;
  size: number;
  modifiedAt: string;
  extension: string;
};

export type ImageManagerListing = {
  currentDir: string;
  currentDisplayPath: string;
  parentDir: string | null;
  breadcrumbs: ImageManagerBreadcrumb[];
  directories: ImageManagerDirectoryEntry[];
  files: ImageManagerFileEntry[];
};

export type UploadedImageResult = {
  name: string;
  relativeDir: string;
  webPath: string;
  size: number;
};
