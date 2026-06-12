import { promises as fs } from "node:fs";
import path from "node:path";

export const IMAGE_MANAGER_ROOT = path.join(process.cwd(), "public", "images");

const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  ".avif",
]);

export type ImageManagerBreadcrumb = {
  label: string;
  relativePath: string;
};

export type ImageManagerDirectoryEntry = {
  name: string;
  relativePath: string;
};

export type ImageManagerImageEntry = {
  name: string;
  relativePath: string;
  webPath: string;
  size: number;
  modifiedAt: string;
  extension: string;
};

export type ImageManagerListing = {
  rootLabel: string;
  currentDir: string;
  currentDisplayPath: string;
  parentDir: string | null;
  breadcrumbs: ImageManagerBreadcrumb[];
  directories: ImageManagerDirectoryEntry[];
  images: ImageManagerImageEntry[];
};

export type SavedImageEntry = {
  name: string;
  relativePath: string;
  webPath: string;
  size: number;
};

export function normalizeRelativeImageDir(input: string): string {
  const cleaned = input.replace(/\\/g, "/").trim();

  if (!cleaned || cleaned === ".") {
    return "";
  }

  const segments = cleaned.split("/").filter(Boolean);
  for (const segment of segments) {
    if (segment === "." || segment === "..") {
      throw new Error("Invalid directory path");
    }
    if (segment.includes(":")) {
      throw new Error("Invalid directory path");
    }
  }

  return segments.join("/");
}

function resolveWithinRoot(relativeDir: string): string {
  const resolved = path.resolve(
    IMAGE_MANAGER_ROOT,
    relativeDir.replaceAll("/", path.sep),
  );
  const relative = path.relative(IMAGE_MANAGER_ROOT, resolved);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Invalid directory path");
  }

  return resolved;
}

export function resolveImageDirectory(relativeDir: string): string {
  return resolveWithinRoot(normalizeRelativeImageDir(relativeDir));
}

export function resolveImageFilePath(
  relativeDir: string,
  fileName: string,
): string {
  const safeFileName = path.basename(fileName.trim());
  if (!safeFileName) {
    throw new Error("Invalid file name");
  }

  return resolveWithinRoot(
    normalizeRelativeImageDir(relativeDir)
      ? `${normalizeRelativeImageDir(relativeDir)}/${safeFileName}`
      : safeFileName,
  );
}

export async function ensureImageRoot(): Promise<void> {
  await fs.mkdir(IMAGE_MANAGER_ROOT, { recursive: true });
}

function buildBreadcrumbs(relativeDir: string): ImageManagerBreadcrumb[] {
  const breadcrumbs: ImageManagerBreadcrumb[] = [
    { label: "images", relativePath: "" },
  ];

  if (!relativeDir) {
    return breadcrumbs;
  }

  const segments = relativeDir.split("/");
  let accumulated = "";

  for (const segment of segments) {
    accumulated = accumulated ? `${accumulated}/${segment}` : segment;
    breadcrumbs.push({ label: segment, relativePath: accumulated });
  }

  return breadcrumbs;
}

function getParentDir(relativeDir: string): string | null {
  if (!relativeDir) {
    return null;
  }

  const segments = relativeDir.split("/");
  segments.pop();
  return segments.join("/");
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function listImageDirectory(
  relativeDir: string,
): Promise<ImageManagerListing> {
  await ensureImageRoot();

  const normalizedDir = normalizeRelativeImageDir(relativeDir);
  const currentDirPath = resolveWithinRoot(normalizedDir);

  if (normalizedDir && !(await pathExists(currentDirPath))) {
    throw new Error("Directory not found");
  }

  const entries = await fs.readdir(currentDirPath, { withFileTypes: true });
  const directories: ImageManagerDirectoryEntry[] = [];
  const images: ImageManagerImageEntry[] = [];

  for (const entry of entries) {
    if (entry.name.startsWith(".")) {
      continue;
    }

    const entryRelativePath = normalizedDir
      ? `${normalizedDir}/${entry.name}`
      : entry.name;

    if (entry.isDirectory()) {
      directories.push({
        name: entry.name,
        relativePath: entryRelativePath,
      });
      continue;
    }

    const extension = path.extname(entry.name).toLowerCase();
    if (!IMAGE_EXTENSIONS.has(extension)) {
      continue;
    }

    const filePath = resolveWithinRoot(entryRelativePath);
    const stats = await fs.stat(filePath);

    images.push({
      name: entry.name,
      relativePath: entryRelativePath,
      webPath: `/images/${entryRelativePath.replace(/\\/g, "/")}`,
      size: stats.size,
      modifiedAt: stats.mtime.toISOString(),
      extension,
    });
  }

  directories.sort((a, b) => a.name.localeCompare(b.name));
  images.sort((a, b) => a.name.localeCompare(b.name));

  return {
    rootLabel: "public/images",
    currentDir: normalizedDir,
    currentDisplayPath: normalizedDir
      ? `public/images/${normalizedDir}`
      : "public/images",
    parentDir: getParentDir(normalizedDir),
    breadcrumbs: buildBreadcrumbs(normalizedDir),
    directories,
    images,
  };
}

export async function createImageDirectory(
  relativeDir: string,
  folderName: string,
): Promise<string> {
  await ensureImageRoot();

  const currentDir = normalizeRelativeImageDir(relativeDir);
  const childDir = normalizeRelativeImageDir(folderName);
  if (!childDir) {
    throw new Error("Folder name is required");
  }

  const targetRelativeDir = currentDir ? `${currentDir}/${childDir}` : childDir;
  const targetPath = resolveWithinRoot(targetRelativeDir);

  if (await pathExists(targetPath)) {
    throw new Error("That directory already exists");
  }

  await fs.mkdir(targetPath, { recursive: true });
  return targetRelativeDir;
}

function isAllowedImageUpload(file: File): boolean {
  const extension = path.extname(file.name).toLowerCase();
  return IMAGE_EXTENSIONS.has(extension) || file.type.startsWith("image/");
}

export async function saveImageUploads(
  relativeDir: string,
  files: File[],
): Promise<SavedImageEntry[]> {
  await ensureImageRoot();

  const normalizedDir = normalizeRelativeImageDir(relativeDir);
  const targetDir = resolveWithinRoot(normalizedDir);

  if (!(await pathExists(targetDir))) {
    throw new Error("Target directory does not exist");
  }

  const saved: SavedImageEntry[] = [];

  for (const file of files) {
    const safeName = path.basename(file.name.trim());
    if (!safeName) {
      throw new Error("One of the uploaded files has no name");
    }

    if (!isAllowedImageUpload(file)) {
      throw new Error(`${safeName} is not a supported image file`);
    }

    const destinationPath = resolveWithinRoot(
      normalizedDir ? `${normalizedDir}/${safeName}` : safeName,
    );

    if (await pathExists(destinationPath)) {
      throw new Error(`${safeName} already exists in this folder`);
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    await fs.writeFile(destinationPath, buffer);

    saved.push({
      name: safeName,
      relativePath: normalizedDir ? `${normalizedDir}/${safeName}` : safeName,
      webPath: normalizedDir
        ? `/images/${normalizedDir}/${safeName}`
        : `/images/${safeName}`,
      size: buffer.byteLength,
    });
  }

  return saved;
}
