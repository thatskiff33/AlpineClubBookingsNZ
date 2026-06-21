"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  ArrowRight,
  CircleHelp,
  Edit3,
  FileText,
  Folder,
  ListOrdered,
  List,
  Loader2,
  Plus,
  Save,
  Trash2,
  Upload,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { EditablePageRecord } from "@/lib/page-content";
import { isSystemPageSlug, SYSTEM_PAGE_SLUGS } from "@/lib/page-content";

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function formatUpdatedAt(value: string | null): string {
  if (!value) {
    return "Never updated";
  }
  return new Date(value).toLocaleString("en-NZ", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export type WysiwygEditorHandle = {
  getHtml: () => string;
};

type MediaImageSummary = {
  id: string;
  filename: string;
  url: string;
  contentType: string;
  byteSize: number;
  altText: string | null;
  width: number | null;
  height: number | null;
  createdAt: string;
};

type PickerImage = {
  url: string;
  label: string;
  source: "uploaded" | "branding" | "filesystem";
  id?: string;
};

type FilesystemImageEntry = {
  filename: string;
  url: string;
};

function parsePixelDimension(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

const UPLOADABLE_IMAGE_TYPES =
  "image/png,image/jpeg,image/gif,image/webp,image/avif,image/svg+xml";

// Exported for reuse by other admin HTML-content editors (lodge instructions).
export const WysiwygEditor = forwardRef<
  WysiwygEditorHandle,
  {
    value: string;
    onChange: (html: string) => void;
    placeholder?: string;
    editorClassName?: string;
    wrapperClassName?: string;
  }
>(function WysiwygEditor(
  {
    value,
    onChange,
    placeholder,
    editorClassName = "min-h-48",
    wrapperClassName,
  },
  ref,
) {
  const [showHtmlFallback, setShowHtmlFallback] = useState(false);
  const [imagePickerOpen, setImagePickerOpen] = useState(false);
  const [loadingSiteImages, setLoadingSiteImages] = useState(false);
  const [siteImages, setSiteImages] = useState<string[]>([]);
  const [loadingUploadedImages, setLoadingUploadedImages] = useState(false);
  const [uploadedImages, setUploadedImages] = useState<MediaImageSummary[]>([]);
  const [uploading, setUploading] = useState(false);
  const [imageFilter, setImageFilter] = useState("");
  const [selectedImagePath, setSelectedImagePath] = useState("");
  const [pickerDir, setPickerDir] = useState("__root__");
  const [pickerDirs, setPickerDirs] = useState<string[]>(["__root__"]);
  const [loadingPickerDirs, setLoadingPickerDirs] = useState(false);
  const [filesystemImages, setFilesystemImages] = useState<
    FilesystemImageEntry[]
  >([]);
  const [loadingFilesystemImages, setLoadingFilesystemImages] = useState(false);
  const [imageWidth, setImageWidth] = useState("");
  const [imageHeight, setImageHeight] = useState("");
  const [mountTick, setMountTick] = useState(0);
  const [resizeRect, setResizeRect] = useState<{
    top: number;
    left: number;
    width: number;
    height: number;
  } | null>(null);
  const editorDivRef = useRef<HTMLDivElement | null>(null);
  const selectionRef = useRef<Range | null>(null);
  const debounceRef = useRef<number | null>(null);
  const resizeTargetRef = useRef<HTMLImageElement | null>(null);
  const dragStateRef = useRef<{
    handle: string;
    startX: number;
    startY: number;
    startW: number;
    startH: number;
  } | null>(null);
  const imageFileInputRef = useRef<HTMLInputElement | null>(null);

  const pickerImages = useMemo<PickerImage[]>(() => {
    const filesystem: PickerImage[] = filesystemImages.map((img) => ({
      url: img.url,
      label: img.filename,
      source: "filesystem",
    }));
    // Only show uploaded + branding sources when viewing the root directory
    if (pickerDir !== "__root__") {
      return filesystem;
    }
    const uploaded: PickerImage[] = uploadedImages.map((image) => ({
      url: image.url,
      label: image.filename,
      source: "uploaded",
      id: image.id,
    }));
    const branding: PickerImage[] = siteImages.map((path) => ({
      url: path,
      label: path,
      source: "branding",
    }));
    return [...uploaded, ...branding, ...filesystem];
  }, [siteImages, uploadedImages, filesystemImages, pickerDir]);

  const filteredPickerImages = useMemo(() => {
    const needle = imageFilter.trim().toLowerCase();
    if (!needle) {
      return pickerImages;
    }
    return pickerImages.filter((img) =>
      img.label.toLowerCase().includes(needle),
    );
  }, [imageFilter, pickerImages]);

  const setEditorNode = useCallback((node: HTMLDivElement | null) => {
    editorDivRef.current = node;
    if (node) setMountTick((v) => v + 1);
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      getHtml: () => {
        if (!showHtmlFallback && editorDivRef.current) {
          return editorDivRef.current.innerHTML ?? "";
        }
        return value;
      },
    }),
    [showHtmlFallback, value],
  );

  useEffect(() => {
    if (showHtmlFallback || !editorDivRef.current) return;
    if (document.activeElement === editorDivRef.current) return;
    if (editorDivRef.current.innerHTML !== value) {
      editorDivRef.current.innerHTML = value;
    }
  }, [showHtmlFallback, value, mountTick]);

  useEffect(() => {
    return () => {
      if (debounceRef.current !== null)
        window.clearTimeout(debounceRef.current);
    };
  }, []);

  // Keep resize overlay in sync when the editor scrolls.
  useEffect(() => {
    const editor = editorDivRef.current;
    if (!editor) return;
    function onScroll() {
      const img = resizeTargetRef.current;
      if (!img) return;
      const r = img.getBoundingClientRect();
      setResizeRect({
        top: r.top,
        left: r.left,
        width: r.width,
        height: r.height,
      });
    }
    editor.addEventListener("scroll", onScroll);
    return () => editor.removeEventListener("scroll", onScroll);
  }, [mountTick]);

  // Clear resize overlay when switching to HTML mode.
  useEffect(() => {
    if (showHtmlFallback) {
      resizeTargetRef.current = null;
      setResizeRect(null);
    }
  }, [showHtmlFallback]);

  useEffect(() => {
    if (!imagePickerOpen) {
      return;
    }

    let cancelled = false;
    setLoadingSiteImages(true);
    setLoadingUploadedImages(true);

    fetch("/api/admin/site-images", {
      credentials: "same-origin",
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => {
        if (cancelled) {
          return;
        }
        const nextImages = Array.isArray(body?.images)
          ? (body.images as string[])
          : [];
        setSiteImages(nextImages);
      })
      .catch(() => {
        if (!cancelled) {
          setSiteImages([]);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingSiteImages(false);
        }
      });

    fetch("/api/admin/image-library?pageSize=100", {
      credentials: "same-origin",
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => {
        if (cancelled) {
          return;
        }
        const nextImages = Array.isArray(body?.images)
          ? (body.images as MediaImageSummary[])
          : [];
        setUploadedImages(nextImages);
      })
      .catch(() => {
        if (!cancelled) {
          setUploadedImages([]);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingUploadedImages(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [imagePickerOpen]);

  // Load directories for the filesystem picker
  useEffect(() => {
    if (!imagePickerOpen) return;

    let cancelled = false;
    setLoadingPickerDirs(true);
    fetch("/api/admin/image-manager/directories", {
      credentials: "same-origin",
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        if (cancelled) return;
        const dirs = Array.isArray(body?.directories)
          ? (body.directories as string[])
          : [""];
        setPickerDirs(dirs.map((d) => (d === "" ? "__root__" : d)));
      })
      .catch(() => {
        if (!cancelled) setPickerDirs(["__root__"]);
      })
      .finally(() => {
        if (!cancelled) setLoadingPickerDirs(false);
      });

    return () => {
      cancelled = true;
    };
  }, [imagePickerOpen]);

  // Load filesystem images for the selected directory
  useEffect(() => {
    if (!imagePickerOpen) return;

    let cancelled = false;
    setFilesystemImages([]);
    setLoadingFilesystemImages(true);
    const apiDir = pickerDir === "__root__" ? "" : pickerDir;
    fetch(`/api/admin/image-manager/images?dir=${encodeURIComponent(apiDir)}`, {
      credentials: "same-origin",
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        if (cancelled) return;
        const imgs = Array.isArray(body?.images)
          ? (body.images as FilesystemImageEntry[])
          : [];
        setFilesystemImages(imgs);
      })
      .catch(() => {
        if (!cancelled) setFilesystemImages([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingFilesystemImages(false);
      });

    return () => {
      cancelled = true;
    };
  }, [imagePickerOpen, pickerDir]);

  useEffect(() => {
    if (
      !imagePickerOpen ||
      loadingSiteImages ||
      loadingUploadedImages ||
      loadingFilesystemImages
    ) {
      return;
    }
    setSelectedImagePath((current) => current || pickerImages[0]?.url || "");
  }, [
    imagePickerOpen,
    loadingSiteImages,
    loadingUploadedImages,
    loadingFilesystemImages,
    pickerImages,
  ]);

  function handleEditorClick(e: React.MouseEvent<HTMLDivElement>) {
    const target = e.target as HTMLElement;
    if (target.tagName === "IMG") {
      const img = target as HTMLImageElement;
      resizeTargetRef.current = img;
      const r = img.getBoundingClientRect();
      setResizeRect({
        top: r.top,
        left: r.left,
        width: r.width,
        height: r.height,
      });
    } else {
      resizeTargetRef.current = null;
      setResizeRect(null);
    }
  }

  function startHandleDrag(e: React.MouseEvent, handle: string) {
    e.preventDefault();
    e.stopPropagation();
    const img = resizeTargetRef.current;
    if (!img) return;
    const r = img.getBoundingClientRect();
    dragStateRef.current = {
      handle,
      startX: e.clientX,
      startY: e.clientY,
      startW: r.width,
      startH: r.height,
    };

    function onMouseMove(ev: MouseEvent) {
      const target = resizeTargetRef.current;
      const ds = dragStateRef.current;
      if (!target || !ds) return;
      const dx = ev.clientX - ds.startX;
      const dy = ev.clientY - ds.startY;
      let newW = ds.startW;
      let newH = ds.startH;
      if (ds.handle.includes("e")) newW = Math.max(20, ds.startW + dx);
      if (ds.handle.includes("w")) newW = Math.max(20, ds.startW - dx);
      if (ds.handle.includes("s")) newH = Math.max(20, ds.startH + dy);
      if (ds.handle.includes("n")) newH = Math.max(20, ds.startH - dy);
      // Persist resized image dimensions via attributes so sanitization keeps them.
      target.setAttribute("width", String(Math.round(newW)));
      target.setAttribute("height", String(Math.round(newH)));
      target.style.removeProperty("width");
      target.style.removeProperty("height");
      const rr = target.getBoundingClientRect();
      setResizeRect({
        top: rr.top,
        left: rr.left,
        width: rr.width,
        height: rr.height,
      });
    }

    function onMouseUp() {
      dragStateRef.current = null;
      onChange(editorDivRef.current?.innerHTML ?? "");
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    }

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }

  function captureSelection() {
    if (showHtmlFallback) return;
    const editor = editorDivRef.current;
    if (!editor) return;
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    if (editor.contains(range.commonAncestorContainer)) {
      selectionRef.current = range.cloneRange();
    }
  }

  function runCommand(command: string, val?: string) {
    if (showHtmlFallback) return;
    const selection = window.getSelection();
    if (selectionRef.current && selection) {
      selection.removeAllRanges();
      selection.addRange(selectionRef.current);
    }
    editorDivRef.current?.focus();
    document.execCommand(command, false, val);
    captureSelection();
    onChange(editorDivRef.current?.innerHTML ?? "");
  }

  function onInput() {
    if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      onChange(editorDivRef.current?.innerHTML ?? "");
    }, 120);
  }

  function onToolbarMouseDown(
    event: React.MouseEvent<HTMLButtonElement>,
    action: () => void,
  ) {
    event.preventDefault();
    action();
  }

  function insertLink() {
    if (showHtmlFallback) return;
    const href = window.prompt("Enter link URL", "https://");
    if (!href) return;
    runCommand("createLink", href);
  }

  function openImagePicker() {
    if (showHtmlFallback) return;
    captureSelection();
    setImageFilter("");
    setPickerDir("__root__");
    setImageWidth("");
    setImageHeight("");
    setImagePickerOpen(true);
  }

  function insertSelectedImage() {
    if (!selectedImagePath) return;

    // Restore saved selection then insert manually so we can set size attributes.
    const selection = window.getSelection();
    if (selectionRef.current && selection) {
      selection.removeAllRanges();
      selection.addRange(selectionRef.current);
    }
    editorDivRef.current?.focus();

    const img = document.createElement("img");
    img.src = selectedImagePath;
    const width = parsePixelDimension(imageWidth);
    const height = parsePixelDimension(imageHeight);
    if (width !== null) {
      img.setAttribute("width", String(width));
    }
    if (height !== null) {
      img.setAttribute("height", String(height));
    }

    // Insert the element at the current caret position.
    const range =
      selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
    if (range) {
      range.deleteContents();
      range.insertNode(img);
      range.setStartAfter(img);
      range.collapse(true);
      selection?.removeAllRanges();
      selection?.addRange(range);
    } else {
      editorDivRef.current?.appendChild(img);
    }

    captureSelection();
    onChange(editorDivRef.current?.innerHTML ?? "");
    setImagePickerOpen(false);
  }

  function triggerImageUpload() {
    imageFileInputRef.current?.click();
  }

  async function uploadImageFile(file: File) {
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append("file", file);

      const response = await fetch("/api/admin/image-library", {
        method: "POST",
        credentials: "same-origin",
        body: formData,
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(body?.error ?? "Failed to upload image");
      }

      const uploaded = body.image as MediaImageSummary;
      setUploadedImages((current) => [uploaded, ...current]);
      setSelectedImagePath(uploaded.url);
      toast.success(`Uploaded ${uploaded.filename}`);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to upload image",
      );
    } finally {
      setUploading(false);
    }
  }

  async function deleteUploadedImage(
    image: MediaImageSummary,
    event: React.MouseEvent,
  ) {
    event.stopPropagation();
    if (!window.confirm(`Delete ${image.filename}? This cannot be undone.`)) {
      return;
    }

    try {
      const response = await fetch(`/api/admin/image-library/${image.id}`, {
        method: "DELETE",
        credentials: "same-origin",
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(body?.error ?? "Failed to delete image");
      }

      setUploadedImages((current) =>
        current.filter((item) => item.id !== image.id),
      );
      if (selectedImagePath === image.url) {
        setSelectedImagePath("");
      }

      const referencedBySlugs = Array.isArray(body?.referencedBySlugs)
        ? (body.referencedBySlugs as string[])
        : [];
      if (referencedBySlugs.length > 0) {
        toast.warning(
          `Deleted ${image.filename}, but it is still referenced on: ${referencedBySlugs.join(", ")}. Those images will now be broken.`,
        );
      } else {
        toast.success(`Deleted ${image.filename}`);
      }
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to delete image",
      );
    }
  }

  function addHorizontalRule() {
    runCommand("insertHorizontalRule");
  }

  return (
    <div
      className={`flex flex-col gap-1${
        wrapperClassName ? ` ${wrapperClassName}` : ""
      }`}
    >
      <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2">
        <p className="text-sm text-slate-600">
          {showHtmlFallback
            ? "HTML editor mode is active."
            : "Visual editor mode is active."}
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {!showHtmlFallback ? (
            <>
              <Button
                size="sm"
                className="h-7 px-2 text-xs"
                type="button"
                variant="outline"
                onMouseDown={(event) =>
                  onToolbarMouseDown(event, () =>
                    runCommand("formatBlock", "P"),
                  )
                }
              >
                Paragraph
              </Button>
              <Button
                size="sm"
                className="h-7 px-2 text-xs"
                type="button"
                variant="outline"
                onMouseDown={(event) =>
                  onToolbarMouseDown(event, () =>
                    runCommand("formatBlock", "H1"),
                  )
                }
              >
                H1
              </Button>
              <Button
                size="sm"
                className="h-7 px-2 text-xs"
                type="button"
                variant="outline"
                onMouseDown={(event) =>
                  onToolbarMouseDown(event, () =>
                    runCommand("formatBlock", "H2"),
                  )
                }
              >
                H2
              </Button>
              <Button
                size="sm"
                className="h-7 px-2 text-xs"
                type="button"
                variant="outline"
                onMouseDown={(event) =>
                  onToolbarMouseDown(event, () =>
                    runCommand("formatBlock", "H3"),
                  )
                }
              >
                H3
              </Button>
              <Button
                size="sm"
                className="h-7 px-2 text-xs"
                type="button"
                variant="outline"
                onMouseDown={(event) =>
                  onToolbarMouseDown(event, () => runCommand("bold"))
                }
              >
                Bold
              </Button>
              <Button
                size="sm"
                className="h-7 px-2 text-xs"
                type="button"
                variant="outline"
                onMouseDown={(event) =>
                  onToolbarMouseDown(event, () => runCommand("italic"))
                }
              >
                Italic
              </Button>
              <Button
                size="sm"
                className="h-7 px-2 text-xs"
                type="button"
                variant="outline"
                onMouseDown={(event) =>
                  onToolbarMouseDown(event, () => runCommand("underline"))
                }
              >
                Underline
              </Button>
              <Button
                size="sm"
                className="h-7 px-2 text-xs"
                type="button"
                variant="outline"
                aria-label="Bullet"
                title="Bullet"
                onMouseDown={(event) =>
                  onToolbarMouseDown(event, () =>
                    runCommand("insertUnorderedList"),
                  )
                }
              >
                <List className="h-4 w-4" />
              </Button>
              <Button
                size="sm"
                className="h-7 px-2 text-xs"
                type="button"
                variant="outline"
                aria-label="Numbered list"
                title="Numbered"
                onMouseDown={(event) =>
                  onToolbarMouseDown(event, () =>
                    runCommand("insertOrderedList"),
                  )
                }
              >
                <ListOrdered className="h-4 w-4" />
              </Button>
              <Button
                size="sm"
                className="h-7 px-2 text-xs"
                type="button"
                variant="outline"
                aria-label="Indent"
                title="Indent"
                onMouseDown={(event) =>
                  onToolbarMouseDown(event, () => runCommand("indent"))
                }
              >
                <ArrowRight className="h-4 w-4" />
              </Button>
              <Button
                size="sm"
                className="h-7 px-2 text-xs"
                type="button"
                variant="outline"
                aria-label="Align left"
                title="Align left"
                onMouseDown={(event) =>
                  onToolbarMouseDown(event, () => runCommand("justifyLeft"))
                }
              >
                <AlignLeft className="h-4 w-4" />
              </Button>
              <Button
                size="sm"
                className="h-7 px-2 text-xs"
                type="button"
                variant="outline"
                aria-label="Align center"
                title="Align center"
                onMouseDown={(event) =>
                  onToolbarMouseDown(event, () => runCommand("justifyCenter"))
                }
              >
                <AlignCenter className="h-4 w-4" />
              </Button>
              <Button
                size="sm"
                className="h-7 px-2 text-xs"
                type="button"
                variant="outline"
                aria-label="Align right"
                title="Align right"
                onMouseDown={(event) =>
                  onToolbarMouseDown(event, () => runCommand("justifyRight"))
                }
              >
                <AlignRight className="h-4 w-4" />
              </Button>
              <Button
                size="sm"
                className="h-7 px-2 text-xs"
                type="button"
                variant="outline"
                onMouseDown={(event) =>
                  onToolbarMouseDown(event, addHorizontalRule)
                }
              >
                HR
              </Button>
              <Button
                size="sm"
                className="h-7 px-2 text-xs"
                type="button"
                variant="outline"
                onMouseDown={(event) => onToolbarMouseDown(event, insertLink)}
              >
                Link
              </Button>
              <Button
                size="sm"
                className="h-7 px-2 text-xs"
                type="button"
                variant="outline"
                onMouseDown={(event) =>
                  onToolbarMouseDown(event, openImagePicker)
                }
              >
                Image
              </Button>
              <Button
                size="sm"
                className="h-7 px-2 text-xs"
                type="button"
                variant="outline"
                onMouseDown={(event) =>
                  onToolbarMouseDown(event, () => runCommand("removeFormat"))
                }
              >
                Clear
              </Button>
            </>
          ) : null}
          <Button
            size="sm"
            className="h-7 px-2 text-xs"
            type="button"
            variant="outline"
            onClick={() => setShowHtmlFallback((current) => !current)}
          >
            {showHtmlFallback ? "Use Visual Editor" : "HTML Editor"}
          </Button>
        </div>
      </div>
      {showHtmlFallback ? (
        <Textarea
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className={`${editorClassName} font-mono text-sm`}
          placeholder={placeholder}
        />
      ) : (
        <div
          ref={setEditorNode}
          contentEditable
          suppressContentEditableWarning
          onKeyUp={captureSelection}
          onMouseUp={captureSelection}
          onBlur={captureSelection}
          onInput={onInput}
          onClick={handleEditorClick}
          className={`${editorClassName} overflow-y-auto rounded-md border border-slate-300 bg-white p-3 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-400 [&_a]:text-blue-700 [&_a]:underline [&_a]:decoration-blue-400 [&_b]:font-bold [&_blockquote]:my-3 [&_blockquote]:border-l-4 [&_blockquote]:border-slate-300 [&_blockquote]:pl-3 [&_blockquote]:italic [&_code]:rounded [&_code]:bg-slate-100 [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_em]:italic [&_h1]:mt-4 [&_h1]:mb-2 [&_h1]:text-3xl [&_h1]:font-bold [&_h2]:mt-4 [&_h2]:mb-2 [&_h2]:text-2xl [&_h2]:font-bold [&_h3]:mt-3 [&_h3]:mb-2 [&_h3]:text-xl [&_h3]:font-semibold [&_hr]:my-4 [&_hr]:border-slate-300 [&_i]:italic [&_li]:my-1 [&_ol]:my-3 [&_ol]:list-decimal [&_ol]:pl-6 [&_p]:my-2 [&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-slate-100 [&_pre]:p-3 [&_pre]:font-mono [&_strong]:font-bold [&_table]:my-3 [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:border-slate-300 [&_td]:p-2 [&_th]:border [&_th]:border-slate-300 [&_th]:bg-slate-100 [&_th]:p-2 [&_u]:underline [&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-6`}
        />
      )}

      <Dialog open={imagePickerOpen} onOpenChange={setImagePickerOpen}>
        <DialogContent className="flex max-h-[85vh] flex-col overflow-hidden sm:max-w-3xl">
          <DialogHeader className="shrink-0">
            <DialogTitle>Insert Image</DialogTitle>
            <DialogDescription>
              Pick an uploaded image, an image deployed with the site
              (public/branding), or upload a new image (PNG, JPEG, GIF, WebP,
              AVIF, or SVG, up to 2MB).
            </DialogDescription>
          </DialogHeader>

          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden">
            {/* Directory selector */}
            <div className="flex shrink-0 items-center gap-2">
              <Folder className="h-4 w-4 shrink-0 text-slate-400" />
              <Select
                value={pickerDir}
                onValueChange={(val) => {
                  setPickerDir(val);
                  setSelectedImagePath("");
                }}
                disabled={loadingPickerDirs}
              >
                <SelectTrigger className="flex-1 text-xs">
                  <SelectValue placeholder="Select folder…" />
                </SelectTrigger>
                <SelectContent>
                  {pickerDirs.map((dir) => (
                    <SelectItem key={dir} value={dir} className="text-xs">
                      {dir === "__root__"
                        ? "images/ (root)"
                        : dir.replace(/\//g, " / ")}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Filter + upload row */}
            <div className="flex shrink-0 items-center gap-2">
              <Input
                value={imageFilter}
                onChange={(event) => setImageFilter(event.target.value)}
                placeholder="Filter images by name"
                className="flex-1"
              />
              <input
                ref={imageFileInputRef}
                type="file"
                accept={UPLOADABLE_IMAGE_TYPES}
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) {
                    void uploadImageFile(file);
                  }
                  event.target.value = "";
                }}
              />
              <Button
                type="button"
                variant="outline"
                onClick={triggerImageUpload}
                disabled={uploading}
              >
                {uploading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Upload className="h-4 w-4" />
                )}
                Upload
              </Button>
            </div>

            {/* Thumbnail grid */}
            <div className="min-h-0 flex-1 overflow-y-auto rounded-md border border-slate-200 bg-slate-50 p-2">
              {loadingSiteImages ||
              loadingUploadedImages ||
              loadingFilesystemImages ? (
                <p className="p-3 text-sm text-slate-500">Loading images…</p>
              ) : filteredPickerImages.length === 0 ? (
                <p className="p-3 text-sm text-slate-500">
                  No images found. Upload one to get started.
                </p>
              ) : (
                <div className="grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-2">
                  {filteredPickerImages.map((image) => {
                    const isSelected = selectedImagePath === image.url;
                    const shortLabel = image.label.includes("/")
                      ? (image.label.split("/").pop() ?? image.label)
                      : image.label;
                    return (
                      <div
                        key={`${image.source}:${image.url}`}
                        className={`group relative cursor-pointer overflow-hidden rounded-lg border-2 bg-white shadow-sm transition-all ${
                          isSelected
                            ? "border-blue-500 ring-2 ring-blue-200"
                            : "border-slate-200 hover:border-slate-400 hover:shadow-md"
                        }`}
                        onClick={() => {
                          setSelectedImagePath(image.url);
                          setImageWidth("");
                          setImageHeight("");
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            setSelectedImagePath(image.url);
                            setImageWidth("");
                            setImageHeight("");
                          }
                        }}
                        role="button"
                        tabIndex={0}
                        aria-pressed={isSelected}
                        aria-label={shortLabel}
                      >
                        {/* Thumbnail */}
                        <div className="relative aspect-square overflow-hidden bg-slate-100">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={image.url}
                            alt={shortLabel}
                            className="h-full w-full object-cover"
                            loading="lazy"
                          />
                          {/* Delete button (uploaded only — filesystem images are managed via Image Manager) */}
                          {image.source === "uploaded" ? (
                            <button
                              type="button"
                              aria-label={`Delete ${shortLabel}`}
                              title={`Delete ${shortLabel}`}
                              onClick={(event) => {
                                event.stopPropagation();
                                const uploaded = uploadedImages.find(
                                  (item) => item.id === image.id,
                                );
                                if (uploaded) {
                                  void deleteUploadedImage(uploaded, event);
                                }
                              }}
                              className="absolute right-1 top-1 rounded-full bg-white/80 p-1 opacity-0 shadow-sm transition-opacity hover:bg-red-50 group-hover:opacity-100"
                            >
                              <Trash2 className="h-3 w-3 text-red-500" />
                            </button>
                          ) : null}
                        </div>

                        {/* Label row */}
                        <div className="p-1.5">
                          <p
                            className="truncate text-xs font-medium text-slate-800"
                            title={image.label}
                          >
                            {shortLabel}
                          </p>
                          <Badge
                            variant={
                              image.source === "uploaded"
                                ? "default"
                                : image.source === "filesystem"
                                  ? "outline"
                                  : "secondary"
                            }
                            className="mt-0.5 text-[9px] uppercase"
                          >
                            {image.source === "uploaded"
                              ? "Uploaded"
                              : image.source === "filesystem"
                                ? "Images"
                                : "Branding"}
                          </Badge>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Selected path strip + resize inputs */}
            {selectedImagePath ? (
              <div className="shrink-0 space-y-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-2">
                <div className="flex items-center gap-2">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={selectedImagePath}
                    alt="Selected"
                    className="h-10 w-10 shrink-0 rounded border border-slate-200 object-cover"
                  />
                  <p className="min-w-0 flex-1 truncate text-xs text-slate-600">
                    {selectedImagePath}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <span className="shrink-0 text-xs text-slate-500">Size:</span>
                  <Input
                    value={imageWidth}
                    onChange={(e) => setImageWidth(e.target.value)}
                    placeholder="Width (px, e.g. 300)"
                    className="h-7 flex-1 text-xs"
                  />
                  <span className="shrink-0 text-xs text-slate-400">×</span>
                  <Input
                    value={imageHeight}
                    onChange={(e) => setImageHeight(e.target.value)}
                    placeholder="Height (px, optional)"
                    className="h-7 flex-1 text-xs"
                  />
                </div>
                <p className="text-[10px] text-slate-400">
                  Enter pixel values only. Leave blank for natural size.
                </p>
              </div>
            ) : null}

            {/* Footer */}
            <div className="flex shrink-0 justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setImagePickerOpen(false)}
              >
                Cancel
              </Button>
              <Button
                type="button"
                onClick={insertSelectedImage}
                disabled={!selectedImagePath}
              >
                Insert Image
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Drag-resize overlay — rendered in a portal so it escapes any stacking context */}
      {resizeRect &&
        !showHtmlFallback &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            style={{
              position: "fixed",
              top: resizeRect.top,
              left: resizeRect.left,
              width: resizeRect.width,
              height: resizeRect.height,
              zIndex: 99999,
              pointerEvents: "none",
            }}
          >
            {/* Selection border */}
            <div
              style={{
                position: "absolute",
                inset: 0,
                border: "2px solid #3b82f6",
                boxSizing: "border-box",
              }}
            />
            {/* Size label */}
            <div
              style={{
                position: "absolute",
                top: -22,
                left: 0,
                background: "#3b82f6",
                color: "white",
                fontSize: 11,
                padding: "2px 6px",
                borderRadius: 3,
                whiteSpace: "nowrap",
                pointerEvents: "none",
              }}
            >
              {Math.round(resizeRect.width)} × {Math.round(resizeRect.height)}{" "}
              px
            </div>
            {/* 8 resize handles */}
            {(
              [
                { h: "nw", style: { top: -5, left: -5, cursor: "nw-resize" } },
                {
                  h: "n",
                  style: {
                    top: -5,
                    left: "50%",
                    transform: "translateX(-50%)",
                    cursor: "n-resize",
                  },
                },
                { h: "ne", style: { top: -5, right: -5, cursor: "ne-resize" } },
                {
                  h: "e",
                  style: {
                    top: "50%",
                    right: -5,
                    transform: "translateY(-50%)",
                    cursor: "e-resize",
                  },
                },
                {
                  h: "se",
                  style: { bottom: -5, right: -5, cursor: "se-resize" },
                },
                {
                  h: "s",
                  style: {
                    bottom: -5,
                    left: "50%",
                    transform: "translateX(-50%)",
                    cursor: "s-resize",
                  },
                },
                {
                  h: "sw",
                  style: { bottom: -5, left: -5, cursor: "sw-resize" },
                },
                {
                  h: "w",
                  style: {
                    top: "50%",
                    left: -5,
                    transform: "translateY(-50%)",
                    cursor: "w-resize",
                  },
                },
              ] as const
            ).map(({ h, style }) => (
              <div
                key={h}
                style={{
                  position: "absolute",
                  width: 10,
                  height: 10,
                  background: "white",
                  border: "2px solid #3b82f6",
                  borderRadius: 2,
                  boxSizing: "border-box",
                  pointerEvents: "all",
                  ...style,
                }}
                onMouseDown={(e) => startHandleDrag(e, h)}
              />
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
});

export function PageContentPanel() {
  const [pages, setPages] = useState<EditablePageRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [creating, setCreating] = useState(false);
  const [helpDialogOpen, setHelpDialogOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [selectedPageId, setSelectedPageId] = useState<string | null>(null);
  const [draftCaption, setDraftCaption] = useState("");
  const [draftMenuTitle, setDraftMenuTitle] = useState("");
  const [draftTitle, setDraftTitle] = useState("");
  const [draftHeaderText, setDraftHeaderText] = useState("");
  const [draftSlug, setDraftSlug] = useState("");
  const [draftSortOrder, setDraftSortOrder] = useState(100);
  const [draftContent, setDraftContent] = useState("");
  const [newCaption, setNewCaption] = useState("");
  const [newMenuTitle, setNewMenuTitle] = useState("");
  const [newTitle, setNewTitle] = useState("");
  const [newHeaderText, setNewHeaderText] = useState("");
  const [newSlug, setNewSlug] = useState("");
  const [newSortOrder, setNewSortOrder] = useState(100);
  const bodyEditorRef = useRef<WysiwygEditorHandle | null>(null);
  const headerEditorRef = useRef<WysiwygEditorHandle | null>(null);

  const selectedPage = useMemo(
    () => pages.find((page) => page.id === selectedPageId) ?? null,
    [pages, selectedPageId],
  );

  async function loadPages() {
    setLoading(true);
    try {
      const response = await fetch("/api/admin/page-content", {
        credentials: "same-origin",
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(body?.error ?? "Failed to load editable pages");
      }
      setPages(body.pages ?? []);
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Failed to load editable pages",
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadPages();
  }, []);

  function openEditor(page: EditablePageRecord) {
    setSelectedPageId(page.id);
    setDraftCaption(page.caption ?? "");
    setDraftMenuTitle(page.menuTitle ?? "");
    setDraftTitle(page.title);
    setDraftHeaderText(page.headerText ?? "");
    setDraftSlug(page.slug);
    // Always use the canonical sort order for system pages regardless of DB value.
    setDraftSortOrder(SYSTEM_PAGE_SLUGS.get(page.slug) ?? page.sortOrder);
    setDraftContent(page.contentHtml ?? "");
    setDialogOpen(true);
  }

  async function saveContent() {
    if (!selectedPage) return;

    const currentContent = bodyEditorRef.current?.getHtml() ?? draftContent;
    const currentHeaderText =
      headerEditorRef.current?.getHtml() ?? draftHeaderText;
    setDraftContent(currentContent);
    setDraftHeaderText(currentHeaderText);

    setSaving(true);
    try {
      const response = await fetch("/api/admin/page-content", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: selectedPage.id,
          caption: draftCaption.trim(),
          menuTitle: draftMenuTitle.trim(),
          title: draftTitle.trim(),
          headerText: currentHeaderText,
          slug: draftSlug.trim().toLowerCase(),
          sortOrder: draftSortOrder,
          contentHtml: currentContent,
        }),
      });

      const body = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(body?.error ?? "Failed to save page content");
      }

      setPages((current) =>
        current
          .map((page) =>
            page.id === selectedPage.id
              ? {
                  ...page,
                  caption: body.page?.caption ?? draftCaption,
                  menuTitle: body.page?.menuTitle ?? draftMenuTitle,
                  title: body.page?.title ?? draftTitle,
                  headerText: body.page?.headerText ?? draftHeaderText,
                  slug: body.page?.slug ?? draftSlug,
                  path: body.page?.path ?? page.path,
                  sortOrder: body.page?.sortOrder ?? draftSortOrder,
                  contentHtml: body.page?.contentHtml ?? draftContent,
                  updatedAt: body.page?.updatedAt ?? new Date().toISOString(),
                  updatedByMemberId:
                    body.page?.updatedByMemberId ?? page.updatedByMemberId,
                }
              : page,
          )
          .sort((a, b) =>
            a.sortOrder === b.sortOrder
              ? a.title.localeCompare(b.title)
              : a.sortOrder - b.sortOrder,
          ),
      );
      toast.success(
        `${draftTitle.trim() || selectedPage.title} page content saved`,
      );
      setDialogOpen(false);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to save page content",
      );
    } finally {
      setSaving(false);
    }
  }

  async function createPage() {
    const title = newTitle.trim();
    const slug = newSlug.trim().toLowerCase();

    if (!title || !slug) {
      toast.error("Title and slug are required");
      return;
    }

    setCreating(true);
    try {
      const response = await fetch("/api/admin/page-content", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          caption: newCaption.trim(),
          menuTitle: newMenuTitle.trim(),
          title,
          headerText: newHeaderText.trim(),
          slug,
          sortOrder: newSortOrder,
        }),
      });

      const body = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(body?.error ?? "Failed to create page");
      }

      const createdPage = body.page as EditablePageRecord;
      setPages((current) =>
        [...current, createdPage].sort((a, b) =>
          a.sortOrder === b.sortOrder
            ? a.title.localeCompare(b.title)
            : a.sortOrder - b.sortOrder,
        ),
      );
      setNewCaption("");
      setNewMenuTitle("");
      setNewTitle("");
      setNewHeaderText("");
      setNewSlug("");
      setNewSortOrder(100);
      setAddDialogOpen(false);
      toast.success(`Created ${createdPage.title}`);
      openEditor(createdPage);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to create page",
      );
    } finally {
      setCreating(false);
    }
  }

  if (loading) {
    return <p className="text-sm text-slate-500">Loading editable pages...</p>;
  }

  return (
    <>
      <div className="mb-4 flex items-center justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          size="icon"
          onClick={() => setHelpDialogOpen(true)}
          aria-label="Page Content help"
          title="Page Content help"
        >
          <CircleHelp className="h-4 w-4" />
        </Button>
        <Button type="button" onClick={() => setAddDialogOpen(true)}>
          <Plus className="h-4 w-4" />
          Add Page
        </Button>
      </div>

      <Dialog open={helpDialogOpen} onOpenChange={setHelpDialogOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Page Content help</DialogTitle>
            <DialogDescription>
              On this page you can create pages that will appear on the public
              pages.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm leading-6 text-slate-700">
            <p>
              <i>
                <b>Slug</b>
              </i>{" "}
              is a unique single id as a single word.
            </p>
            <p>
              <i>
                <b>Menu Order</b>
              </i>{" "}
              is the order this page will be in the menu.
            </p>
            <p>
              <i>
                <b>Caption</b>
              </i>{" "}
              The topic name of the page. This is displayed in the header panel.
            </p>
            <p>
              <i>
                <b>Menu Title</b>
              </i>{" "}
              The name to display in the menu. Leave blank if you do not want
              this page to display in the menu.
            </p>
            <p>
              <i>
                <b>Page Title</b>
              </i>{" "}
              The title name of the page. This is displayed in the header panel.
            </p>
            <p>
              <i>
                <b>Header Text</b>
              </i>{" "}
              The text displayed under the page title in the header panel.
            </p>
            <p>
              <i>
                <b>Body</b>
              </i>{" "}
              The information to display in the body of the page.
            </p>

            <p>
              <i>
                <b>Note</b>
              </i>{" "}
              Any <i>Style</i> or <i>Script</i> tags will be removed apon save
              as these can pose a security risk.
            </p>
            <p>
              If you want a background image in your header panel. Goto{" "}
              <b>Site Style</b> page and create the style for your page.
            </p>
            <pre className="overflow-x-auto rounded-md bg-slate-900 p-3 text-xs text-slate-100">
              {`.dynamic-header[data-page-slug="home"] {
    background: url('/api/images/uploaded/zzz.jpg') center / cover no-repeat;
}`}
            </pre>

            <p>
              In the content editor you can add any of the following tokens by
              having the token name in {"{{}}"}. E.G.{" "}
              <code>{"{{contact-form}}"}</code>
            </p>
            <p>
              <i>
                <b>committee-members-cards</b>
              </i>
              <br />
              This will display cards in a grid with a committee member in each
              one.
            </p>
            <p>
              <i>
                <b>member-application-form</b>
              </i>
              <br />
              This will display the Membership application form.
            </p>
            <p>
              <i>
                <b>join-apply-form</b>
              </i>
              <br />
              This will display the Membership application form.
            </p>
            <p>
              <i>
                <b>contact-form</b>
              </i>
              <br />
              This will display a contact us form where a user can sent a
              message to the committee.
            </p>
            <p>
              <i>
                <b>skifield-conditions</b>
              </i>
              <br />
              This will display the Ski resort status, weather, chairlift
              status, road status.
              <br />
              You will need to go to https://www.snow.nz/snow-report-widget and
              select the skifield you want information on.
              <br />
              On submit you will be shown a script. On the first line, copy the
              hash code within the quotes. e.g. data-hash=&quot;zzz&quot;.
              <br />
              On this editor page do the following, while replacing zzz with
              your hashcode. <code>{"{{skifield-conditions:zzz}}"}</code>
            </p>
            <p>
              <i>
                <b>skifield-whakapapa</b>
              </i>
              <br />
              This will fetch the Whakapapa report and render a parsed curlData
              JSON object.
              <br />
              On this editor page do the following:{" "}
              <code>{"{{skifield-whakapapa}}"}</code>
            </p>
            <p>
              <i>
                <b>photo-gallery</b>
              </i>
              <br />
              This will display a PhotoSwipe gallery using the images already
              inserted into the page body.
              <br />
              Add your images to the page body, then place the token where the
              gallery should appear.
              <br />
              You can also pass a folder path, for example:
              <code>{"{{photo-gallery:/public/images/photos/One}}"}</code>
            </p>
            <p>
              <i>
                <b>photo-slideshow</b>
              </i>
              <br />
              This will display the same images in a slideshow-oriented
              PhotoSwipe layout.
              <br />
              Use the same folder-path format when you want to load all photos
              from a directory.
              <br />
              For example:{" "}
              <code>{"{{photo-slideshow:/public/images/photos/One}}"}</code>
            </p>
          </div>
        </DialogContent>
      </Dialog>

      <div className="grid gap-4 md:grid-cols-2">
        {pages.map((page) => {
          const textPreview = stripHtml(page.contentHtml);
          const hasContent = textPreview.length > 0;
          const isSystem = isSystemPageSlug(page.slug);
          const hasMenuTitle = page.menuTitle.trim().length > 0;

          return (
            <Card key={page.slug}>
              <CardHeader>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <CardTitle>{page.title}</CardTitle>
                    <CardDescription>{page.path}</CardDescription>
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
                    {isSystem && (
                      <Badge
                        variant="outline"
                        className="text-[10px] uppercase text-slate-500"
                      >
                        System
                      </Badge>
                    )}
                    {!hasMenuTitle && (
                      <Badge
                        variant="outline"
                        className="text-[10px] uppercase text-slate-500"
                      >
                        No menu
                      </Badge>
                    )}
                    <Badge variant={hasContent ? "default" : "secondary"}>
                      {hasContent ? "Has content" : "Empty"}
                    </Badge>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="text-xs text-slate-500">
                  Menu order: {page.sortOrder}
                </p>
                <p className="min-h-10 rounded-md border border-slate-200 bg-slate-50 p-2 text-xs text-slate-600">
                  {hasContent
                    ? `${textPreview.slice(0, 180)}${textPreview.length > 180 ? "..." : ""}`
                    : "No content saved yet."}
                </p>
                <p className="text-xs text-slate-500">
                  Updated: {formatUpdatedAt(page.updatedAt)}
                </p>
                <Button type="button" onClick={() => openEditor(page)}>
                  <Edit3 className="h-4 w-4" />
                  Edit {page.title}
                </Button>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <Dialog open={addDialogOpen} onOpenChange={setAddDialogOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Add Page</DialogTitle>
            <DialogDescription>
              Create a new website page. The slug defines the URL path and menu
              link.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <p className="text-sm font-medium text-slate-800">Slug</p>
              <Input
                value={newSlug}
                onChange={(event) =>
                  setNewSlug(event.target.value.trim().toLowerCase())
                }
                placeholder="trip-reports"
              />
              <p className="text-xs text-slate-500">
                Path preview: /{newSlug || "your-page"}
              </p>
            </div>
            <div className="space-y-1">
              <p className="text-sm font-medium text-slate-800">Menu order</p>
              <Input
                type="number"
                value={newSortOrder}
                onChange={(event) =>
                  setNewSortOrder(
                    Number.parseInt(event.target.value || "0", 10),
                  )
                }
                min={0}
              />
            </div>
            <div className="space-y-1">
              <p className="text-sm font-medium text-slate-800">Caption</p>
              <Input
                value={newCaption}
                onChange={(event) => setNewCaption(event.target.value)}
                placeholder="A practical alpine club"
              />
            </div>
            <div className="space-y-1">
              <p className="text-sm font-medium text-slate-800">Menu title</p>
              <Input
                value={newMenuTitle}
                onChange={(event) => setNewMenuTitle(event.target.value)}
                placeholder="About"
              />
            </div>
            <div className="space-y-1">
              <p className="text-sm font-medium text-slate-800">Page title</p>
              <Input
                value={newTitle}
                onChange={(event) => setNewTitle(event.target.value)}
                placeholder="Trip Reports"
              />
            </div>
            <div className="space-y-1">
              <p className="text-sm font-medium text-slate-800">Header text</p>
              <Textarea
                value={newHeaderText}
                onChange={(event) => setNewHeaderText(event.target.value)}
                className="min-h-24"
                placeholder="Short intro text shown under the title"
              />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setAddDialogOpen(false)}
              >
                Cancel
              </Button>
              <Button type="button" onClick={createPage} disabled={creating}>
                {creating ? "Creating..." : "Create Page"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="flex h-[85vh] max-h-[85vh] flex-col overflow-hidden sm:max-w-5xl">
          <DialogHeader>
            <DialogTitle>
              {selectedPage
                ? `Edit ${selectedPage.title} Page Content`
                : "Edit Page Content"}
            </DialogTitle>
            <DialogDescription>
              Changes are sanitized before save and then rendered from
              PostgreSQL on the public page.
            </DialogDescription>
          </DialogHeader>

          {selectedPage ? (
            <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-1">
              <div className="grid gap-3 rounded-md border border-slate-200 bg-slate-50 p-3 md:grid-cols-2">
                <label className="space-y-1">
                  <span className="text-xs font-medium text-slate-700">
                    Slug
                    {isSystemPageSlug(selectedPage.slug) && (
                      <span className="ml-2 rounded bg-slate-200 px-1 py-0.5 text-[10px] font-normal text-slate-500">
                        fixed
                      </span>
                    )}
                  </span>
                  <Input
                    value={draftSlug}
                    onChange={(event) =>
                      setDraftSlug(event.target.value.trim().toLowerCase())
                    }
                    placeholder="page-slug"
                    readOnly={isSystemPageSlug(selectedPage.slug)}
                    className={
                      isSystemPageSlug(selectedPage.slug)
                        ? "cursor-not-allowed bg-slate-100 opacity-70"
                        : ""
                    }
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-xs font-medium text-slate-700">
                    Menu order
                    {isSystemPageSlug(selectedPage.slug) && (
                      <span className="ml-2 rounded bg-slate-200 px-1 py-0.5 text-[10px] font-normal text-slate-500">
                        fixed at {SYSTEM_PAGE_SLUGS.get(selectedPage.slug)}
                      </span>
                    )}
                  </span>
                  <Input
                    type="number"
                    value={draftSortOrder}
                    onChange={(event) =>
                      setDraftSortOrder(
                        Number.parseInt(event.target.value || "0", 10),
                      )
                    }
                    min={0}
                    readOnly={isSystemPageSlug(selectedPage.slug)}
                    className={
                      isSystemPageSlug(selectedPage.slug)
                        ? "cursor-not-allowed bg-slate-100 opacity-70"
                        : ""
                    }
                  />
                </label>
                <div className="md:col-span-2 text-xs text-slate-600">
                  Public path: /{draftSlug || "page-slug"}
                </div>
                <div className="md:col-span-2 grid grid-cols-3 gap-3">
                  <label className="space-y-1">
                    <span className="text-xs font-medium text-slate-700">
                      Caption
                    </span>
                    <Input
                      value={draftCaption}
                      onChange={(event) => setDraftCaption(event.target.value)}
                      placeholder="A practical alpine club"
                    />
                  </label>
                  <label className="space-y-1">
                    <span className="text-xs font-medium text-slate-700">
                      Menu title
                    </span>
                    <Input
                      value={draftMenuTitle}
                      onChange={(event) =>
                        setDraftMenuTitle(event.target.value)
                      }
                      placeholder="About"
                    />
                  </label>
                  <label className="space-y-1">
                    <span className="text-xs font-medium text-slate-700">
                      Page title
                    </span>
                    <Input
                      value={draftTitle}
                      onChange={(event) => setDraftTitle(event.target.value)}
                      placeholder="Page title"
                    />
                  </label>
                </div>
                <div className="space-y-1 md:col-span-2">
                  <span className="text-xs font-medium text-slate-700">
                    Header text
                  </span>
                  <WysiwygEditor
                    ref={headerEditorRef}
                    key={`header-${selectedPageId ?? "none"}`}
                    value={draftHeaderText}
                    onChange={setDraftHeaderText}
                    placeholder="Short intro text shown under the title"
                    editorClassName="min-h-28"
                  />
                </div>
              </div>

              <WysiwygEditor
                ref={bodyEditorRef}
                key={selectedPageId ?? "none"}
                value={draftContent}
                onChange={setDraftContent}
                placeholder="Enter page HTML here"
                editorClassName="min-h-[320px]"
              />

              <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
                <p className="font-medium text-slate-700">Embed Tokens</p>
                <p className="mt-1">
                  Insert these in page body content using either {"{"}token{"}"}{" "}
                  or
                  {" {{token}}"}:
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <span className="rounded bg-slate-200 px-2 py-1 font-mono text-[11px] text-slate-800">
                    skifield-whakapapa
                  </span>
                  <span className="rounded bg-slate-200 px-2 py-1 font-mono text-[11px] text-slate-800">
                    skifield-conditions
                  </span>
                  <span className="rounded bg-slate-200 px-2 py-1 font-mono text-[11px] text-slate-800">
                    committee-members-cards
                  </span>
                  <span className="rounded bg-slate-200 px-2 py-1 font-mono text-[11px] text-slate-800">
                    member-application-form
                  </span>
                  <span className="rounded bg-slate-200 px-2 py-1 font-mono text-[11px] text-slate-800">
                    join-apply-form
                  </span>
                  <span className="rounded bg-slate-200 px-2 py-1 font-mono text-[11px] text-slate-800">
                    contact-form
                  </span>
                  <span className="rounded bg-slate-200 px-2 py-1 font-mono text-[11px] text-slate-800">
                    photo-gallery
                  </span>
                  <span className="rounded bg-slate-200 px-2 py-1 font-mono text-[11px] text-slate-800">
                    photo-slideshow
                  </span>
                </div>
                <p className="mt-2 text-[11px] text-slate-500">
                  Optional hash override:
                  {" {{skifield-conditions:4297a04af31a54b9b4dc710057f5a492}}"}
                </p>
              </div>

              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setDialogOpen(false)}
                >
                  Cancel
                </Button>
                <Button type="button" onClick={saveContent} disabled={saving}>
                  {saving ? (
                    <FileText className="h-4 w-4 animate-pulse" />
                  ) : (
                    <Save className="h-4 w-4" />
                  )}
                  {saving ? "Saving..." : "Save"}
                </Button>
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
