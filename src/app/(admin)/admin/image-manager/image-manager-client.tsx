"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  FolderOpen,
  Folder,
  FolderPlus,
  Pencil,
  Trash2,
  UploadCloud,
  ImageIcon,
  RotateCcw,
  ChevronRight,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ImageEntry {
  filename: string;
  url: string;
  byteSize: number;
  modifiedAt: string;
}

type DialogMode =
  | { kind: "create-dir" }
  | { kind: "rename-dir"; path: string }
  | { kind: "delete-dir"; path: string }
  | { kind: "delete-image"; dir: string; filename: string }
  | null;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function dirLabel(rel: string): string {
  if (!rel) return "images/ (root)";
  return rel.replace(/\//g, " / ");
}

function dirDepth(rel: string): number {
  if (!rel) return 0;
  return rel.split("/").length;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function ImageManagerClient() {
  const [directories, setDirectories] = useState<string[]>([""]);
  const [selectedDir, setSelectedDir] = useState<string>("");
  const [images, setImages] = useState<ImageEntry[]>([]);
  const [loadingImages, setLoadingImages] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [dialog, setDialog] = useState<DialogMode>(null);
  const [dialogInput, setDialogInput] = useState("");
  const [dialogBusy, setDialogBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragCounterRef = useRef(0);

  // ── Load directories ────────────────────────────────────────────────────────

  const loadDirectories = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/image-manager/directories");
      if (!res.ok) throw new Error("Failed to load directories");
      const data = (await res.json()) as { directories: string[] };
      setDirectories(data.directories);
    } catch {
      toast.error("Could not load directory list");
    }
  }, []);

  useEffect(() => {
    loadDirectories();
  }, [loadDirectories]);

  // ── Load images for selected directory ──────────────────────────────────────

  const loadImages = useCallback(async (dir: string) => {
    setLoadingImages(true);
    setImages([]);
    try {
      const res = await fetch(
        `/api/admin/image-manager/images?dir=${encodeURIComponent(dir)}`,
      );
      if (!res.ok) throw new Error("Failed to load images");
      const data = (await res.json()) as { images: ImageEntry[] };
      setImages(data.images);
    } catch {
      toast.error("Could not load images");
    } finally {
      setLoadingImages(false);
    }
  }, []);

  useEffect(() => {
    loadImages(selectedDir);
  }, [selectedDir, loadImages]);

  // ── Upload ───────────────────────────────────────────────────────────────────

  const uploadFiles = useCallback(
    async (files: FileList | File[]) => {
      const fileArray = Array.from(files);
      if (!fileArray.length) return;

      setUploading(true);
      const formData = new FormData();
      formData.append("dir", selectedDir);
      for (const f of fileArray) {
        formData.append("files", f);
      }

      try {
        const res = await fetch("/api/admin/image-manager/upload", {
          method: "POST",
          body: formData,
        });
        const data = (await res.json()) as {
          results?: Array<{ filename: string; ok: boolean; error?: string }>;
          error?: string;
        };
        // A non-ok response (e.g. storage volume missing/read-only) carries a
        // single { error } message rather than per-file results — surface it.
        if (!res.ok || !data.results) {
          throw new Error(data.error ?? "Upload failed");
        }
        const failed = data.results.filter((r) => !r.ok);
        const succeeded = data.results.filter((r) => r.ok);

        if (succeeded.length) {
          toast.success(
            `${succeeded.length} image${succeeded.length > 1 ? "s" : ""} uploaded`,
          );
          await loadImages(selectedDir);
        }
        for (const f of failed) {
          toast.error(`${f.filename}: ${f.error ?? "Upload failed"}`);
        }
      } catch (err: unknown) {
        toast.error(err instanceof Error ? err.message : "Upload failed");
      } finally {
        setUploading(false);
        if (fileInputRef.current) fileInputRef.current.value = "";
      }
    },
    [selectedDir, loadImages],
  );

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) uploadFiles(e.target.files);
  };

  // ── Drag-and-drop ─────────────────────────────────────────────────────────

  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current++;
    setDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current--;
    if (dragCounterRef.current === 0) setDragging(false);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current = 0;
    setDragging(false);
    const files = e.dataTransfer.files;
    if (files.length) uploadFiles(files);
  };

  // ── Directory operations ─────────────────────────────────────────────────

  const openCreateDir = () => {
    setDialogInput("");
    setDialog({ kind: "create-dir" });
  };

  const openRenameDir = (p: string) => {
    const leaf = p.includes("/") ? p.split("/").pop()! : p;
    setDialogInput(leaf);
    setDialog({ kind: "rename-dir", path: p });
  };

  const openDeleteDir = (p: string) => {
    setDialog({ kind: "delete-dir", path: p });
  };

  const openDeleteImage = (filename: string) => {
    setDialog({ kind: "delete-image", dir: selectedDir, filename });
  };

  const closeDialog = () => {
    if (!dialogBusy) setDialog(null);
  };

  const handleDialogConfirm = async () => {
    if (!dialog) return;
    setDialogBusy(true);

    try {
      if (dialog.kind === "create-dir") {
        const res = await fetch("/api/admin/image-manager/directories", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: dialogInput.trim(),
            parent: selectedDir,
          }),
        });
        if (!res.ok) {
          const d = (await res.json()) as { error?: string };
          throw new Error(d.error ?? "Failed to create directory");
        }
        toast.success("Directory created");
        await loadDirectories();
      }

      if (dialog.kind === "rename-dir") {
        const res = await fetch("/api/admin/image-manager/directories", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            path: dialog.path,
            newName: dialogInput.trim(),
          }),
        });
        if (!res.ok) {
          const d = (await res.json()) as { error?: string };
          throw new Error(d.error ?? "Failed to rename directory");
        }
        toast.success("Directory renamed");
        // If the renamed dir was selected, update selection
        if (
          selectedDir === dialog.path ||
          selectedDir.startsWith(dialog.path + "/")
        ) {
          setSelectedDir("");
        }
        await loadDirectories();
      }

      if (dialog.kind === "delete-dir") {
        const res = await fetch("/api/admin/image-manager/directories", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: dialog.path }),
        });
        if (!res.ok) {
          const d = (await res.json()) as { error?: string };
          throw new Error(d.error ?? "Failed to delete directory");
        }
        toast.success("Directory deleted");
        if (
          selectedDir === dialog.path ||
          selectedDir.startsWith(dialog.path + "/")
        ) {
          setSelectedDir("");
        }
        await loadDirectories();
      }

      if (dialog.kind === "delete-image") {
        const res = await fetch("/api/admin/image-manager/images", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dir: dialog.dir, filename: dialog.filename }),
        });
        if (!res.ok) {
          const d = (await res.json()) as { error?: string };
          throw new Error(d.error ?? "Failed to delete image");
        }
        toast.success("Image deleted");
        await loadImages(selectedDir);
      }

      setDialog(null);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "An error occurred");
    } finally {
      setDialogBusy(false);
    }
  };

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Image Manager</h1>
        <p className="mt-1 text-sm text-slate-500">
          Upload and organise images stored in{" "}
          <code className="rounded bg-slate-100 px-1 py-0.5 text-xs">
            public/images/
          </code>
          .
        </p>
      </div>

      {/* Current directory breadcrumb */}
      <div className="flex items-center gap-1 text-sm text-slate-600">
        <span className="font-medium text-slate-400">Saving to:</span>
        <span className="font-medium">images/</span>
        {selectedDir && (
          <>
            <ChevronRight className="h-3 w-3 text-slate-400" />
            <span className="font-medium text-slate-800">
              {selectedDir.replace(/\//g, " / ")}
            </span>
          </>
        )}
      </div>

      <div className="grid grid-cols-[260px_1fr] gap-6 items-start">
        {/* ── Left: Directory panel ── */}
        <Card className="overflow-hidden">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2 pt-4 px-4">
            <CardTitle className="text-sm font-semibold text-slate-700">
              Directories
            </CardTitle>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 gap-1 text-xs"
              onClick={openCreateDir}
              title="New folder in current directory"
            >
              <FolderPlus className="h-3.5 w-3.5" />
              New
            </Button>
          </CardHeader>
          <CardContent className="px-1 pb-3">
            <ul className="space-y-0.5">
              {directories.map((dir) => {
                const isSelected = dir === selectedDir;
                const depth = dirDepth(dir);
                return (
                  <li key={dir ?? "__root__"}>
                    <div
                      className={cn(
                        "group flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors",
                        isSelected
                          ? "bg-slate-100 font-medium text-slate-900"
                          : "text-slate-600 hover:bg-slate-50 hover:text-slate-900",
                      )}
                      style={{ paddingLeft: `${8 + depth * 12}px` }}
                      onClick={() => setSelectedDir(dir)}
                    >
                      {isSelected ? (
                        <FolderOpen className="h-4 w-4 shrink-0 text-amber-500" />
                      ) : (
                        <Folder className="h-4 w-4 shrink-0 text-slate-400 group-hover:text-amber-400" />
                      )}
                      <span className="flex-1 truncate">{dirLabel(dir)}</span>
                      {dir && (
                        <span className="flex shrink-0 items-center gap-0.5 opacity-0 group-hover:opacity-100">
                          <button
                            title="Rename"
                            className="rounded p-0.5 hover:bg-slate-200"
                            onClick={(e) => {
                              e.stopPropagation();
                              openRenameDir(dir);
                            }}
                          >
                            <Pencil className="h-3 w-3 text-slate-500" />
                          </button>
                          <button
                            title="Delete"
                            className="rounded p-0.5 hover:bg-red-100"
                            onClick={(e) => {
                              e.stopPropagation();
                              openDeleteDir(dir);
                            }}
                          >
                            <Trash2 className="h-3 w-3 text-red-400" />
                          </button>
                        </span>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>

        {/* ── Right: Upload + Gallery ── */}
        <div className="space-y-4">
          {/* Drop zone */}
          <div
            role="button"
            tabIndex={0}
            className={cn(
              "flex cursor-pointer flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed p-10 text-center transition-colors",
              dragging
                ? "border-blue-400 bg-blue-50 text-blue-700"
                : "border-slate-200 bg-slate-50 text-slate-500 hover:border-slate-300 hover:bg-slate-100",
              uploading && "pointer-events-none opacity-60",
            )}
            onDragEnter={handleDragEnter}
            onDragLeave={handleDragLeave}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
            onClick={() => !uploading && fileInputRef.current?.click()}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                if (!uploading) fileInputRef.current?.click();
              }
            }}
          >
            <UploadCloud
              className={cn(
                "h-10 w-10",
                dragging ? "text-blue-400" : "text-slate-400",
              )}
            />
            {uploading ? (
              <p className="text-sm font-medium">Uploading…</p>
            ) : (
              <>
                <p className="text-sm font-medium">
                  {dragging ? "Drop images here" : "Drag & drop images here"}
                </p>
                <p className="text-xs">or click to select files</p>
                <p className="text-xs text-slate-400">
                  JPG, PNG, GIF, WebP, AVIF, SVG · max 10 MB per file
                </p>
              </>
            )}
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept="image/jpeg,image/png,image/gif,image/webp,image/avif,image/svg+xml"
              className="hidden"
              onChange={handleFileInputChange}
            />
          </div>

          {/* Gallery header */}
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-700">
              {loadingImages
                ? "Loading…"
                : `${images.length} image${images.length !== 1 ? "s" : ""} in this directory`}
            </h2>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 gap-1 text-xs"
              onClick={() => loadImages(selectedDir)}
              disabled={loadingImages}
              title="Refresh"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Refresh
            </Button>
          </div>

          {/* Image grid */}
          {!loadingImages && images.length === 0 && (
            <div className="flex flex-col items-center gap-2 py-16 text-slate-400">
              <ImageIcon className="h-12 w-12" />
              <p className="text-sm">No images in this directory</p>
            </div>
          )}

          {images.length > 0 && (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3">
              {images.map((img) => (
                <div
                  key={img.filename}
                  className="group relative overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm transition-shadow hover:shadow-md"
                >
                  {/* Thumbnail */}
                  <div className="relative aspect-square overflow-hidden bg-slate-50">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={img.url}
                      alt={img.filename}
                      className="h-full w-full object-cover"
                      loading="lazy"
                    />
                    {/* Delete overlay */}
                    <button
                      title={`Delete ${img.filename}`}
                      className="absolute right-1.5 top-1.5 rounded-full bg-white/80 p-1 opacity-0 shadow-sm transition-opacity hover:bg-red-50 group-hover:opacity-100"
                      onClick={() => openDeleteImage(img.filename)}
                    >
                      <Trash2 className="h-3.5 w-3.5 text-red-500" />
                    </button>
                  </div>

                  {/* File info */}
                  <div className="p-2">
                    <p
                      className="truncate text-xs font-medium text-slate-800"
                      title={img.filename}
                    >
                      {img.filename}
                    </p>
                    <p className="mt-0.5 text-xs text-slate-400">
                      {formatBytes(img.byteSize)}
                    </p>
                    <p className="text-xs text-slate-400">
                      {formatDate(img.modifiedAt)}
                    </p>
                    {/* Copy URL */}
                    <button
                      className="mt-1 truncate text-[10px] text-slate-400 hover:text-slate-600 hover:underline"
                      title="Copy URL"
                      onClick={() => {
                        navigator.clipboard.writeText(img.url);
                        toast.success("URL copied to clipboard");
                      }}
                    >
                      {img.url}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ── Dialogs ── */}

      {/* Create directory */}
      <Dialog
        open={dialog?.kind === "create-dir"}
        onOpenChange={() => closeDialog()}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New Folder</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-slate-500">
            Create a new folder inside{" "}
            <span className="font-medium">{dirLabel(selectedDir)}</span>.
          </p>
          <Input
            autoFocus
            placeholder="Folder name"
            value={dialogInput}
            onChange={(e) => setDialogInput(e.target.value)}
            onKeyDown={(e) =>
              e.key === "Enter" && dialogInput.trim() && handleDialogConfirm()
            }
          />
          <DialogFooter>
            <Button variant="ghost" onClick={closeDialog} disabled={dialogBusy}>
              Cancel
            </Button>
            <Button
              onClick={handleDialogConfirm}
              disabled={!dialogInput.trim() || dialogBusy}
            >
              {dialogBusy ? "Creating…" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Rename directory */}
      <Dialog
        open={dialog?.kind === "rename-dir"}
        onOpenChange={() => closeDialog()}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename Folder</DialogTitle>
          </DialogHeader>
          <Input
            autoFocus
            placeholder="New folder name"
            value={dialogInput}
            onChange={(e) => setDialogInput(e.target.value)}
            onKeyDown={(e) =>
              e.key === "Enter" && dialogInput.trim() && handleDialogConfirm()
            }
          />
          <DialogFooter>
            <Button variant="ghost" onClick={closeDialog} disabled={dialogBusy}>
              Cancel
            </Button>
            <Button
              onClick={handleDialogConfirm}
              disabled={!dialogInput.trim() || dialogBusy}
            >
              {dialogBusy ? "Renaming…" : "Rename"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete directory */}
      <Dialog
        open={dialog?.kind === "delete-dir"}
        onOpenChange={() => closeDialog()}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Folder</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-slate-600">
            Permanently delete{" "}
            <span className="font-semibold">
              {dialog?.kind === "delete-dir" ? dirLabel(dialog.path) : ""}
            </span>{" "}
            and all its contents? This cannot be undone.
          </p>
          <DialogFooter>
            <Button variant="ghost" onClick={closeDialog} disabled={dialogBusy}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDialogConfirm}
              disabled={dialogBusy}
            >
              {dialogBusy ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete image */}
      <Dialog
        open={dialog?.kind === "delete-image"}
        onOpenChange={() => closeDialog()}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Image</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-slate-600">
            Permanently delete{" "}
            <span className="font-semibold">
              {dialog?.kind === "delete-image" ? dialog.filename : ""}
            </span>
            ? This cannot be undone.
          </p>
          <DialogFooter>
            <Button variant="ghost" onClick={closeDialog} disabled={dialogBusy}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDialogConfirm}
              disabled={dialogBusy}
            >
              {dialogBusy ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
