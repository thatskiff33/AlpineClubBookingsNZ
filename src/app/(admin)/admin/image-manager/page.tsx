"use client";

import Image from "next/image";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  ChevronRight,
  Folder,
  FolderPlus,
  Image as ImageIcon,
  RefreshCw,
  Upload,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  type ImageManagerDirectoryEntry,
  type ImageManagerImageEntry,
  type ImageManagerListing,
} from "@/lib/image-manager";

type SelectedImageInfo = ImageManagerImageEntry & {
  dimensions: { width: number; height: number } | null;
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString("en-NZ", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function getFolderLabel(relativePath: string): string {
  const segments = relativePath.split("/");
  return segments[segments.length - 1] || "images";
}

function getDirectoryName(currentDir: string): string {
  return currentDir ? `public/images/${currentDir}` : "public/images";
}

function buildBreadcrumbs(
  listing: ImageManagerListing | null,
): Array<{ label: string; relativePath: string }> {
  return listing?.breadcrumbs ?? [{ label: "images", relativePath: "" }];
}

function FolderTile({
  directory,
  onOpen,
}: {
  directory: ImageManagerDirectoryEntry;
  onOpen: (relativePath: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onOpen(directory.relativePath)}
      className="flex items-center gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2 text-left transition-colors hover:border-slate-300 hover:bg-slate-50"
    >
      <Folder className="h-5 w-5 shrink-0 text-amber-500" />
      <div className="min-w-0">
        <div className="truncate text-sm font-medium text-slate-900">
          {directory.name}
        </div>
        <div className="truncate text-xs text-slate-500">Folder</div>
      </div>
    </button>
  );
}

function ImageTile({
  image,
  selected,
  onSelect,
}: {
  image: ImageManagerImageEntry;
  selected: boolean;
  onSelect: (image: ImageManagerImageEntry) => void;
}) {
  const [dimensions, setDimensions] = useState<{
    width: number;
    height: number;
  } | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setDimensions(null);
    setLoadFailed(false);

    const preview = new window.Image();
    preview.onload = () => {
      if (!cancelled) {
        setDimensions({
          width: preview.naturalWidth,
          height: preview.naturalHeight,
        });
      }
    };
    preview.onerror = () => {
      if (!cancelled) {
        setDimensions(null);
        setLoadFailed(true);
      }
    };
    preview.src = image.webPath;

    return () => {
      cancelled = true;
    };
  }, [image.webPath]);

  return (
    <button
      type="button"
      onClick={() => onSelect(image)}
      className={`group flex flex-col overflow-hidden rounded-xl border bg-white text-left shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md ${selected ? "border-brand-charcoal ring-2 ring-brand-charcoal/20" : "border-slate-200"}`}
    >
      <div className="relative h-28 bg-slate-100">
        {loadFailed ? (
          <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-center text-slate-500">
            <ImageIcon className="h-8 w-8" />
            <span className="px-3 text-xs leading-5">Preview unavailable</span>
          </div>
        ) : (
          <Image
            src={image.webPath}
            alt={image.name}
            fill
            unoptimized
            sizes="(max-width: 768px) 33vw, 140px"
            className="object-cover"
            onError={() => setLoadFailed(true)}
          />
        )}
      </div>
      <div className="space-y-1.5 p-2.5">
        <div className="truncate text-xs font-medium text-slate-900">
          {image.name}
        </div>
        <div className="flex flex-wrap gap-1 text-[10px] text-slate-500">
          <Badge
            variant="outline"
            className="border-slate-200 bg-slate-50 px-1.5 py-0 text-[9px] font-normal"
          >
            {formatBytes(image.size)}
          </Badge>
          <Badge
            variant="outline"
            className="border-slate-200 bg-slate-50 px-1.5 py-0 text-[9px] font-normal"
          >
            {image.extension.replace(".", "")}
          </Badge>
          <Badge
            variant="outline"
            className="border-slate-200 bg-slate-50 px-1.5 py-0 text-[9px] font-normal"
          >
            {dimensions
              ? `${dimensions.width} x ${dimensions.height}`
              : "Loading size..."}
          </Badge>
        </div>
      </div>
    </button>
  );
}

export default function ImageManagerPage() {
  const [listing, setListing] = useState<ImageManagerListing | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingFolder, setSavingFolder] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const [currentDir, setCurrentDir] = useState("");
  const [newFolderName, setNewFolderName] = useState("");
  const [queuedFiles, setQueuedFiles] = useState<File[]>([]);
  const [selectedImagePath, setSelectedImagePath] = useState<string | null>(
    null,
  );
  const [selectedPreviewDimensions, setSelectedPreviewDimensions] = useState<{
    width: number;
    height: number;
  } | null>(null);
  const [previewLoadFailed, setPreviewLoadFailed] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const selectedImage = useMemo(
    () =>
      listing?.images.find((image) => image.webPath === selectedImagePath) ??
      null,
    [listing, selectedImagePath],
  );

  const breadcrumbs = useMemo(() => buildBreadcrumbs(listing), [listing]);

  const loadListing = async (dir: string) => {
    setLoading(true);
    setError("");

    try {
      const response = await fetch(
        `/api/admin/image-manager?dir=${encodeURIComponent(dir)}`,
        {
          credentials: "same-origin",
        },
      );
      const body = await response.json().catch(() => null);

      if (!response.ok) {
        throw new Error(body?.error ?? "Failed to load images");
      }

      const nextListing = body.listing as ImageManagerListing;
      setListing(nextListing);
      setCurrentDir(nextListing.currentDir);
      setSelectedImagePath((current) => {
        if (
          current &&
          nextListing.images.some((image) => image.webPath === current)
        ) {
          return current;
        }

        return nextListing.images[0]?.webPath ?? null;
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to load images";
      setError(message);
      toast.error(message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadListing("");
  }, []);

  useEffect(() => {
    if (!selectedImage) {
      setSelectedPreviewDimensions(null);
      return;
    }

    setPreviewLoadFailed(false);
    setSelectedPreviewDimensions(null);

    let cancelled = false;
    const preview = new window.Image();
    preview.onload = () => {
      if (!cancelled) {
        setSelectedPreviewDimensions({
          width: preview.naturalWidth,
          height: preview.naturalHeight,
        });
      }
    };
    preview.onerror = () => {
      if (!cancelled) {
        setSelectedPreviewDimensions(null);
      }
    };
    preview.src = selectedImage.webPath;

    return () => {
      cancelled = true;
    };
  }, [selectedImage?.webPath]);

  function openDirectory(relativePath: string) {
    void loadListing(relativePath);
  }

  function onChooseFiles(files: FileList | File[]) {
    const nextFiles = Array.from(files).filter((file) => file.size > 0);
    setQueuedFiles(nextFiles);
  }

  async function createFolder() {
    const trimmed = newFolderName.trim();
    if (!trimmed) {
      toast.error("Folder name is required");
      return;
    }

    setSavingFolder(true);
    try {
      const response = await fetch("/api/admin/image-manager/folders", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentDir, folderName: trimmed }),
      });

      const body = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(body?.error ?? "Failed to create folder");
      }

      setNewFolderName("");
      toast.success(`Created ${getFolderLabel(body.relativePath)}`);
      await loadListing(currentDir);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to create folder";
      toast.error(message);
    } finally {
      setSavingFolder(false);
    }
  }

  async function uploadFiles() {
    if (queuedFiles.length === 0) {
      toast.error("Choose one or more image files first");
      return;
    }

    setUploading(true);
    try {
      const formData = new FormData();
      formData.set("currentDir", currentDir);
      queuedFiles.forEach((file) => formData.append("files", file));

      const response = await fetch("/api/admin/image-manager/upload", {
        method: "POST",
        credentials: "same-origin",
        body: formData,
      });

      const body = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(body?.error ?? "Failed to upload files");
      }

      setQueuedFiles([]);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
      toast.success(
        `Uploaded ${body.files?.length ?? 0} image${body.files?.length === 1 ? "" : "s"}`,
      );
      await loadListing(currentDir);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to upload files";
      toast.error(message);
    } finally {
      setUploading(false);
    }
  }

  function handleDrop(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    setIsDragging(false);
    onChooseFiles(event.dataTransfer.files);
  }

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h1 className="text-2xl font-bold text-slate-900">Image Manager</h1>
        <p className="max-w-3xl text-sm text-slate-500">
          Upload site images into{" "}
          <span className="font-medium text-slate-700">public/images</span>,
          create nested folders, and browse each directory like a lightweight
          file explorer.
        </p>
      </div>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle>Current directory</CardTitle>
              <CardDescription>
                Files you upload will be saved to the selected folder.
              </CardDescription>
            </div>
            <Button
              type="button"
              variant="outline"
              onClick={() => void loadListing(currentDir)}
              disabled={loading}
            >
              <RefreshCw
                className={`h-4 w-4 ${loading ? "animate-spin" : ""}`}
              />
              Refresh
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-2 text-sm text-slate-600">
            <span className="rounded-full bg-slate-100 px-3 py-1 font-medium text-slate-800">
              {getDirectoryName(currentDir)}
            </span>
            {breadcrumbs.map((crumb, index) => (
              <div
                key={`${crumb.relativePath}-${index}`}
                className="flex items-center gap-2"
              >
                <ChevronRight className="h-4 w-4 text-slate-400" />
                <button
                  type="button"
                  onClick={() => openDirectory(crumb.relativePath)}
                  className="font-medium text-brand-charcoal hover:underline"
                >
                  {crumb.label}
                </button>
              </div>
            ))}
          </div>

          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
            <div className="space-y-4">
              <div
                onDragEnter={(event) => {
                  event.preventDefault();
                  setIsDragging(true);
                }}
                onDragOver={(event) => {
                  event.preventDefault();
                  setIsDragging(true);
                }}
                onDragLeave={(event) => {
                  event.preventDefault();
                  setIsDragging(false);
                }}
                onDrop={handleDrop}
                className={`rounded-xl border-2 border-dashed p-4 transition-colors ${isDragging ? "border-brand-charcoal bg-brand-mist/50" : "border-slate-200 bg-slate-50"}`}
              >
                <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                  <div>
                    <p className="text-sm font-medium text-slate-900">
                      Upload images
                    </p>
                    <p className="text-xs text-slate-500">
                      Drag files here or pick them from your computer.
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => fileInputRef.current?.click()}
                    >
                      <Upload className="h-4 w-4" />
                      Choose Files
                    </Button>
                    <Button
                      type="button"
                      onClick={() => void uploadFiles()}
                      disabled={uploading || queuedFiles.length === 0}
                    >
                      <Upload className="h-4 w-4" />
                      {uploading ? "Uploading..." : "Upload to Folder"}
                    </Button>
                  </div>
                </div>

                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  multiple
                  className="hidden"
                  onChange={(event) => {
                    if (event.target.files) {
                      onChooseFiles(event.target.files);
                    }
                  }}
                />

                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                    Destination:
                  </span>
                  <Badge
                    variant="outline"
                    className="border-slate-200 bg-white text-slate-700"
                  >
                    {getDirectoryName(currentDir)}
                  </Badge>
                </div>

                {queuedFiles.length > 0 ? (
                  <div className="mt-3 space-y-2 rounded-lg border border-slate-200 bg-white p-3">
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-medium text-slate-800">
                        Queued files
                      </p>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setQueuedFiles([])}
                      >
                        Clear
                      </Button>
                    </div>
                    <ul className="max-h-40 space-y-1 overflow-y-auto text-sm text-slate-600">
                      {queuedFiles.map((file) => (
                        <li
                          key={`${file.name}-${file.size}-${file.lastModified}`}
                          className="flex items-center justify-between gap-3 rounded-md bg-slate-50 px-3 py-2"
                        >
                          <span className="truncate">{file.name}</span>
                          <span className="shrink-0 text-xs text-slate-500">
                            {formatBytes(file.size)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>

              <div className="rounded-xl border border-slate-200 bg-white p-4">
                <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
                  <div className="space-y-1">
                    <p className="text-sm font-medium text-slate-900">
                      Create folder
                    </p>
                    <p className="text-xs text-slate-500">
                      Create nested folders under the current directory.
                    </p>
                  </div>
                  <div className="flex gap-2 md:min-w-[420px]">
                    <Input
                      value={newFolderName}
                      onChange={(event) => setNewFolderName(event.target.value)}
                      placeholder="events/2026"
                    />
                    <Button
                      type="button"
                      onClick={() => void createFolder()}
                      disabled={savingFolder}
                    >
                      <FolderPlus className="h-4 w-4" />
                      {savingFolder ? "Creating..." : "Create"}
                    </Button>
                  </div>
                </div>
              </div>

              <Card>
                <CardHeader>
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <CardTitle className="text-lg">Folders</CardTitle>
                      <CardDescription>
                        Open a subfolder to browse images inside it.
                      </CardDescription>
                    </div>
                    <Badge variant="outline">
                      {listing?.directories.length ?? 0} folders
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent>
                  {loading ? (
                    <p className="text-sm text-slate-500">
                      Loading folder contents...
                    </p>
                  ) : listing?.directories.length ? (
                    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                      {listing.directories.map((directory) => (
                        <FolderTile
                          key={directory.relativePath}
                          directory={directory}
                          onOpen={openDirectory}
                        />
                      ))}
                    </div>
                  ) : (
                    <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 p-4 text-sm text-slate-500">
                      No subfolders in this directory yet.
                    </div>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <CardTitle className="text-lg">Images</CardTitle>
                      <CardDescription>
                        Thumbnails, file sizes, and basic metadata for the
                        selected folder.
                      </CardDescription>
                    </div>
                    <Badge variant="outline">
                      {listing?.images.length ?? 0} images
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent>
                  {error ? (
                    <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
                      {error}
                    </div>
                  ) : loading ? (
                    <p className="text-sm text-slate-500">Loading images...</p>
                  ) : listing?.images.length ? (
                    <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
                      {listing.images.map((image) => (
                        <ImageTile
                          key={image.relativePath}
                          image={image}
                          selected={selectedImagePath === image.webPath}
                          onSelect={(nextImage) =>
                            setSelectedImagePath(nextImage.webPath)
                          }
                        />
                      ))}
                    </div>
                  ) : (
                    <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 p-6 text-sm text-slate-500">
                      No images are stored in this folder yet.
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>

            <div className="space-y-4">
              <Card className="sticky top-4">
                <CardHeader>
                  <CardTitle className="text-lg">Preview</CardTitle>
                  <CardDescription>Selected image information.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  {selectedImage ? (
                    <>
                      <div className="relative aspect-square overflow-hidden rounded-xl border border-slate-200 bg-slate-100">
                        {previewLoadFailed ? (
                          <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-center text-slate-500">
                            <ImageIcon className="h-10 w-10" />
                            <span className="px-4 text-sm leading-6">
                              Preview unavailable for this file.
                            </span>
                          </div>
                        ) : (
                          <Image
                            src={selectedImage.webPath}
                            alt={selectedImage.name}
                            fill
                            unoptimized
                            sizes="320px"
                            className="object-contain"
                            onError={() => setPreviewLoadFailed(true)}
                          />
                        )}
                      </div>
                      <div className="space-y-3 text-sm text-slate-600">
                        <div>
                          <p className="text-xs uppercase tracking-wide text-slate-500">
                            File
                          </p>
                          <p className="font-medium text-slate-900">
                            {selectedImage.name}
                          </p>
                        </div>
                        <div>
                          <p className="text-xs uppercase tracking-wide text-slate-500">
                            Directory
                          </p>
                          <p>{getDirectoryName(currentDir)}</p>
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                          <div>
                            <p className="text-xs uppercase tracking-wide text-slate-500">
                              Size
                            </p>
                            <p>{formatBytes(selectedImage.size)}</p>
                          </div>
                          <div>
                            <p className="text-xs uppercase tracking-wide text-slate-500">
                              Type
                            </p>
                            <p>
                              {selectedImage.extension
                                .replace(".", "")
                                .toUpperCase()}
                            </p>
                          </div>
                          <div>
                            <p className="text-xs uppercase tracking-wide text-slate-500">
                              Modified
                            </p>
                            <p>{formatDate(selectedImage.modifiedAt)}</p>
                          </div>
                          <div>
                            <p className="text-xs uppercase tracking-wide text-slate-500">
                              Dimensions
                            </p>
                            <p>
                              {selectedPreviewDimensions
                                ? `${selectedPreviewDimensions.width} x ${selectedPreviewDimensions.height}`
                                : "Loading..."}
                            </p>
                          </div>
                        </div>
                        <div>
                          <p className="text-xs uppercase tracking-wide text-slate-500">
                            Web path
                          </p>
                          <p className="break-all text-xs text-slate-700">
                            {selectedImage.webPath}
                          </p>
                        </div>
                      </div>
                    </>
                  ) : (
                    <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 p-6 text-sm text-slate-500">
                      Select an image to see a preview and metadata.
                    </div>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-lg">Directory info</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2 text-sm text-slate-600">
                  <p>
                    <span className="font-medium text-slate-800">Root:</span>{" "}
                    public/images
                  </p>
                  <p>
                    <span className="font-medium text-slate-800">
                      Selected:
                    </span>{" "}
                    {getDirectoryName(currentDir)}
                  </p>
                  <p>
                    <span className="font-medium text-slate-800">
                      Upload target:
                    </span>{" "}
                    same as selected
                  </p>
                </CardContent>
              </Card>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
