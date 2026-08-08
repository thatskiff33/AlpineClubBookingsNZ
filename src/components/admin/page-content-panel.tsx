"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
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
  Eye,
  EyeOff,
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
import { useConfirm } from "@/components/confirm-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  FieldHint,
  describedByFieldHint,
  useFieldHint,
} from "@/components/ui/field-hint";
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
import {
  canDeletePage,
  canUnpublishPage,
  isSystemPageSlug,
  SYSTEM_PAGE_SLUGS,
} from "@/lib/page-content";
import { emitPublicContentSettingsChanged } from "@/lib/public-content-settings-events";
import {
  TokenCatalogueSections,
  TokenChips,
  TokenHelpDialog,
} from "@/components/admin/token-help-dialog";
import {
  tokensForContext,
  type TokenContextId,
} from "@/lib/token-catalogue";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import {
  AdminForbiddenSaveNotice,
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";
import { formatNZDateTime } from "@/lib/nzst-date";


function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * How a keyed footer section is named inside a sentence about a page delete
 * (#2352, first review finding 3).
 *
 * The footer's link lists are the OTHER place a club authors links, under the
 * same `content` permission, and they render on every public page — so the
 * delete confirmation has to be able to name them. Phrased as sentence
 * fragments rather than as the headings the Site Content panel shows
 * ("Footer: quick links"), because that is where these appear. Keyed by the
 * `SITE_CONTENT_KEYS` string the endpoint reports; an unknown key falls back to
 * itself rather than disappearing from the warning.
 */
const FOOTER_SECTION_LABELS: Record<string, string> = {
  FOOTER_BLURB: "the footer's club blurb",
  FOOTER_QUICK_LINKS: "the footer's quick links",
  FOOTER_AFFILIATIONS: "the footer's affiliations",
};

function describeFooterSections(keys: readonly string[]): string {
  return keys.map((key) => FOOTER_SECTION_LABELS[key] ?? key).join(", ");
}

function formatUpdatedAt(value: string | null): string {
  if (!value) {
    return "Never updated";
  }
  // Club time, not the admin's own (#2264): the stamp says when the club's
  // document changed, so an officer abroad must not read it in their zone.
  return formatNZDateTime(new Date(value));
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

type TextAlignment = "left" | "center" | "right";

const ALIGNMENT_CLASS_BY_VALUE: Record<TextAlignment, string> = {
  left: "wysiwyg-align-left",
  center: "wysiwyg-align-center",
  right: "wysiwyg-align-right",
};

const ALIGNMENT_CLASS_NAMES = Object.values(ALIGNMENT_CLASS_BY_VALUE);

function findAlignedBlock(
  editor: HTMLElement,
  selection: Selection,
): HTMLElement | null {
  if (selection.rangeCount === 0) {
    return null;
  }

  const range = selection.getRangeAt(0);
  const anchor =
    range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
      ? (range.commonAncestorContainer as Element)
      : range.commonAncestorContainer.parentElement;

  if (!anchor) {
    return null;
  }

  const block = anchor.closest(
    "p, h1, h2, h3, h4, h5, h6, li, blockquote, td, th, div",
  );
  if (!block || !editor.contains(block)) {
    return null;
  }

  return block as HTMLElement;
}

// test seam
export function applyTextAlignmentToSelection(
  editor: HTMLElement,
  selection: Selection,
  alignment: TextAlignment,
): boolean {
  const block = findAlignedBlock(editor, selection);
  if (!block) {
    return false;
  }

  for (const className of ALIGNMENT_CLASS_NAMES) {
    block.classList.remove(className);
  }
  block.classList.add(ALIGNMENT_CLASS_BY_VALUE[alignment]);
  return true;
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
    /**
     * When set, the toolbar shows a token help button listing the tokens
     * available in this editor context (from the shared token catalogue).
     */
    tokenHelpContext?: TokenContextId;
    /**
     * Renders the editor as honestly read-only for view-only admins (#1927):
     * the content area is not editable, the formatting toolbar is hidden, and
     * the HTML fallback textarea is read-only. Viewing controls (HTML source
     * toggle, token help) stay available.
     */
    readOnly?: boolean;
    /**
     * True while the admin's edit access is still resolving (#2065). When the
     * editor is read-only ONLY because the session has not resolved yet, the
     * caption must stay neutral rather than asserting "View only — your admin
     * role cannot edit", which would flash for a privileged admin. The editor
     * still renders as non-editable during this window (the correct neutral).
     */
    resolvingAccess?: boolean;
  }
>(function WysiwygEditor(
  {
    value,
    onChange,
    placeholder,
    editorClassName = "min-h-48",
    wrapperClassName,
    tokenHelpContext,
    readOnly = false,
    resolvingAccess = false,
  },
  ref,
) {
  // #2264: ONE hint serves the width/height pair, but the id must still be
  // per-instance — `WysiwygEditor` is rendered in several places and a module
  // constant would collide the moment two of them mounted at once (today only
  // the Radix dialog unmounting keeps that from happening). `useId` is safe
  // here because this is the component body, not a `.map()` row.
  const imageSizeHintId = useId();
  const [showHtmlFallback, setShowHtmlFallback] = useState(false);
  const [tokenHelpOpen, setTokenHelpOpen] = useState(false);
  const [imagePickerOpen, setImagePickerOpen] = useState(false);
  const { confirm, prompt, confirmDialog } = useConfirm();
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

  async function insertLink() {
    if (showHtmlFallback) return;
    // Capture the editor selection before the dialog steals focus;
    // runCommand restores it before applying the link.
    captureSelection();
    const href = await prompt({
      title: "Insert link",
      inputLabel: "Link URL",
      defaultValue: "https://",
      confirmLabel: "Insert",
    });
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
    if (
      !(await confirm({
        title: `Delete ${image.filename}?`,
        description: "This cannot be undone.",
        confirmLabel: "Delete",
        destructive: true,
      }))
    ) {
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

  function alignSelection(alignment: TextAlignment) {
    if (showHtmlFallback) return;

    const selection = window.getSelection();
    if (selectionRef.current && selection) {
      selection.removeAllRanges();
      selection.addRange(selectionRef.current);
    }

    const editor = editorDivRef.current;
    if (!editor || !selection) {
      return;
    }

    editor.focus();
    if (applyTextAlignmentToSelection(editor, selection, alignment)) {
      captureSelection();
      onChange(editor.innerHTML ?? "");
    }
  }

  return (
    <div
      className={`flex flex-col gap-1${
        wrapperClassName ? ` ${wrapperClassName}` : ""
      }`}
    >
      {confirmDialog}
      <div className="sticky top-0 z-30 rounded-md border border-border bg-muted px-3 py-2 shadow-sm">
        <p className="text-sm text-muted-foreground">
          {readOnly
            ? resolvingAccess
              ? // Neutral while permissions resolve (#2065): don't assert
                // "view only" — the editor is non-editable but we don't yet
                // know whether this admin can edit.
                " "
              : "View only — your admin role cannot edit this content."
            : showHtmlFallback
              ? "HTML editor mode is active."
              : "Visual editor mode is active."}
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {!showHtmlFallback && !readOnly ? (
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
                P
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
                B
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
                i
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
                _
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
                  onToolbarMouseDown(event, () => alignSelection("left"))
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
                  onToolbarMouseDown(event, () => alignSelection("center"))
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
                  onToolbarMouseDown(event, () => alignSelection("right"))
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
          {tokenHelpContext ? (
            <Button
              size="sm"
              className="h-7 px-2 text-xs"
              type="button"
              variant="outline"
              aria-label="Token help"
              title="Token help"
              // Same mouse-down pattern as the other toolbar buttons so the
              // editor selection is not lost when opening the dialog.
              onMouseDown={(event) =>
                onToolbarMouseDown(event, () => setTokenHelpOpen(true))
              }
            >
              <CircleHelp className="h-4 w-4" />
            </Button>
          ) : null}
        </div>
      </div>
      {tokenHelpContext ? (
        <TokenHelpDialog
          context={tokenHelpContext}
          open={tokenHelpOpen}
          onOpenChange={setTokenHelpOpen}
        />
      ) : null}
      {showHtmlFallback ? (
        <Textarea
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className={`${editorClassName} font-mono text-sm`}
          placeholder={placeholder}
          readOnly={readOnly}
        />
      ) : (
        <div
          ref={setEditorNode}
          contentEditable={!readOnly}
          suppressContentEditableWarning
          onKeyUp={readOnly ? undefined : captureSelection}
          onMouseUp={readOnly ? undefined : captureSelection}
          onBlur={readOnly ? undefined : captureSelection}
          onInput={readOnly ? undefined : onInput}
          onClick={readOnly ? undefined : handleEditorClick}
          className={`${editorClassName} overflow-y-auto rounded-md border border-border bg-card p-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring [&_a]:text-info-11 [&_a]:underline [&_a]:decoration-info-11 [&_b]:font-bold [&_blockquote]:my-3 [&_blockquote]:border-l-4 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:italic [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_em]:italic [&_h1]:mt-4 [&_h1]:mb-2 [&_h1]:text-3xl [&_h1]:font-bold [&_h2]:mt-4 [&_h2]:mb-2 [&_h2]:text-2xl [&_h2]:font-bold [&_h3]:mt-3 [&_h3]:mb-2 [&_h3]:text-xl [&_h3]:font-semibold [&_hr]:my-4 [&_hr]:border-border [&_i]:italic [&_li]:my-1 [&_ol]:my-3 [&_ol]:list-decimal [&_ol]:pl-6 [&_p]:my-2 [&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-muted [&_pre]:p-3 [&_pre]:font-mono [&_strong]:font-bold [&_table]:my-3 [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:border-border [&_td]:p-2 [&_th]:border [&_th]:border-border [&_th]:bg-muted [&_th]:p-2 [&_u]:underline [&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-6`}
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
              <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
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
            <div className="min-h-0 flex-1 overflow-y-auto rounded-md border border-border bg-muted p-2">
              {loadingSiteImages ||
              loadingUploadedImages ||
              loadingFilesystemImages ? (
                <p className="p-3 text-sm text-muted-foreground">Loading images…</p>
              ) : filteredPickerImages.length === 0 ? (
                <p className="p-3 text-sm text-muted-foreground">
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
                        className={`group relative cursor-pointer overflow-hidden rounded-lg border-2 bg-card shadow-sm transition-all ${
                          isSelected
                            ? "border-info-7 ring-2 ring-info-7"
                            : "border-border hover:border-muted-foreground hover:shadow-md"
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
                        <div className="relative aspect-square overflow-hidden bg-muted">
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
                              className="absolute right-1 top-1 rounded-full bg-card p-1 opacity-0 shadow-sm transition-opacity hover:bg-danger-3 group-hover:opacity-100"
                            >
                              <Trash2 className="h-3 w-3 text-danger-11" />
                            </button>
                          ) : null}
                        </div>

                        {/* Label row */}
                        <div className="p-1.5">
                          <p
                            className="truncate text-xs font-medium text-foreground"
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
              <div className="shrink-0 space-y-2 rounded-md border border-border bg-muted px-3 py-2">
                <div className="flex items-center gap-2">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={selectedImagePath}
                    alt="Selected"
                    className="h-10 w-10 shrink-0 rounded border border-border object-cover"
                  />
                  <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                    {selectedImagePath}
                  </p>
                </div>
                {/*
                  #2264: "Width (px, e.g. 300)" was doing two jobs at once — it
                  was the field's ONLY name AND carried an example. The name
                  stays in the box (there is no room for a label in this
                  two-up row, and an aria-label now states it properly); the
                  example moves down into the paragraph that was already there,
                  which becomes the row's single hint rather than a second one
                  per box.

                  Each aria-label repeats its placeholder VERBATIM so the
                  spoken name matches the visible name (WCAG 2.5.3 label in
                  name) — a voice-control user can say "Width (px)" and hit the
                  box. The two are worded symmetrically: both dimensions are
                  optional, and the single hint below says so once ("Leave
                  blank for natural size") rather than one box claiming to be
                  optional and its twin implying it is not.
                */}
                <div className="flex items-center gap-2">
                  <span className="shrink-0 text-xs text-muted-foreground">Size:</span>
                  <Input
                    value={imageWidth}
                    onChange={(e) => setImageWidth(e.target.value)}
                    aria-label="Width (px)"
                    aria-describedby={describedByFieldHint(imageSizeHintId)}
                    placeholder="Width (px)"
                    className="h-7 flex-1 text-xs"
                  />
                  <span className="shrink-0 text-xs text-muted-foreground">×</span>
                  <Input
                    value={imageHeight}
                    onChange={(e) => setImageHeight(e.target.value)}
                    aria-label="Height (px)"
                    aria-describedby={describedByFieldHint(imageSizeHintId)}
                    placeholder="Height (px)"
                    className="h-7 flex-1 text-xs"
                  />
                </div>
                <FieldHint
                  id={imageSizeHintId}
                  className="text-[10px]"
                >
                  Enter pixel values only, for example 300. Leave blank for
                  natural size.
                </FieldHint>
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
  const canEdit = useAdminAreaEditAccess("content");
  const { confirm, confirmDialog } = useConfirm();
  const [pages, setPages] = useState<EditablePageRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [forbidden, setForbidden] = useState(false);
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
  /*
    In-flight guard for the one destructive row action on these cards, held in a
    ref rather than derived from a disabled button (AGENTS.md, the row-level
    write rule): two clicks dispatched inside a single tick both see the
    pre-update state, so a disabled attribute is set too late to stop the second
    request. Here the second request would 404 on a row the first already
    removed, which is harmless but reads to the officer as a failure.
  */
  const deleteInFlightRef = useRef<string | null>(null);
  /*
    #2264: the Add-Page dialog and the Edit-Page panel are twins — the same four
    facts about a page, asked twice — so their example values are converted
    together and worded identically. Grey example text inside a control reads as
    a value the page already has (badly misleading in the EDIT panel, where the
    boxes really do hold the page's current caption and menu title) and vanishes
    the moment the admin types. Each example is helper text under its field now,
    tied to the control with aria-describedby.

    The slug hint ABSORBS the "Path preview:" line that already sat under that
    box rather than stacking a second paragraph, and its example matches the one
    the API rejects an invalid slug with (`src/app/api/admin/page-content/route.ts`)
    so the form and the error agree on what a good slug looks like.

    NOT converted here: the edit panel's "page-slug" and "Page title" and the
    "Short intro text shown under the title" / "Enter page HTML here" strings are
    label echoes and instructions, not specimens, so they stay in the control.

    The Add dialog labels its fields with a plain `<p>`, which names nothing, so
    every input that loses its placeholder gains an `aria-label` in the same
    edit. The edit panel's fields are wrapped in a real `<label>`, so the hint is
    rendered OUTSIDE that wrapper — text inside a `<label>` becomes part of the
    control's accessible NAME, and an example is a description, not a name.
  */
  const newSlugHint = useFieldHint();
  const newCaptionHint = useFieldHint();
  const newMenuTitleHint = useFieldHint();
  const newTitleHint = useFieldHint();
  const draftCaptionHint = useFieldHint();
  const draftMenuTitleHint = useFieldHint();

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

  async function togglePublished(page: EditablePageRecord) {
    const nextPublished = !page.published;
    setForbidden(false);
    try {
      const response = await fetch("/api/admin/page-content", {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: page.id, published: nextPublished }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        // The page-content routes' custom forbiddenResponse replies 401
        // ("Unauthorized") on permission denial, so treat 401 as forbidden
        // too — only authenticated admins can reach this panel.
        if (response.status === 403 || response.status === 401)
          setForbidden(true);
        throw new Error(body?.error ?? "Failed to update page visibility");
      }
      setPages((current) =>
        current.map((item) =>
          item.id === page.id
            ? { ...item, published: body.page?.published ?? nextPublished }
            : item,
        ),
      );
      toast.success(
        nextPublished
          ? `Published ${page.title}`
          : `Hidden ${page.title} from the public site`,
      );
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Failed to update page visibility",
      );
    }
  }

  /**
   * Which page the public header's Book Now button currently points at.
   *
   * Read lazily, at the moment the officer asks to delete something, rather than
   * on mount: it is only ever needed to answer one sentence in one dialog, and a
   * failed read must not stop a page load. `undefined` means "could not be
   * determined" and is deliberately distinct from `null` ("nothing is targeted")
   * — the dialog stays silent on the subject rather than asserting either way,
   * and the endpoint's own answer still drives the warning after the delete.
   *
   * The control itself lives in the sibling Public Content Settings panel on the
   * same admin page, so this is a read of that panel's authority, not a second
   * source of truth.
   */
  async function loadBookNowTargetPageId(): Promise<string | null | undefined> {
    try {
      const response = await fetch("/api/admin/public-content-settings", {
        credentials: "same-origin",
      });
      if (!response.ok) {
        return undefined;
      }
      const body = (await response.json()) as {
        settings?: { bookNowTarget?: string; bookNowPageId?: string | null };
      } | null;
      const settings = body?.settings;
      if (!settings || settings.bookNowTarget !== "PAGE") {
        return null;
      }
      return typeof settings.bookNowPageId === "string"
        ? settings.bookNowPageId
        : null;
    } catch {
      return undefined;
    }
  }

  /**
   * Which footer sections link to an address (#2352, first review finding 3).
   *
   * Read lazily for the same reasons as the Book Now target: it answers one
   * sentence in one dialog, and it must not slow or break a page load. The
   * sections are edited in the Site Content panel, so this is a read of that
   * panel's authority rather than a second source of truth, and it uses the same
   * best-effort substring semantics as the endpoint so dialog and toast cannot
   * disagree. An empty array is a real "nothing in the footer points at it"; a
   * failed read returns undefined so the dialog stays silent on the subject
   * rather than asserting either way, and the endpoint's authoritative answer
   * still drives the message afterwards.
   */
  async function loadFooterSectionsLinkingTo(
    path: string,
  ): Promise<string[] | undefined> {
    try {
      const response = await fetch("/api/admin/site-content", {
        credentials: "same-origin",
      });
      if (!response.ok) {
        return undefined;
      }
      const body = (await response.json()) as {
        documents?: Array<{ key?: unknown; contentHtml?: unknown }>;
      } | null;
      if (!Array.isArray(body?.documents)) {
        return undefined;
      }
      return body.documents
        .filter(
          (document) =>
            typeof document.key === "string" &&
            typeof document.contentHtml === "string" &&
            document.contentHtml.includes(path),
        )
        .map((document) => document.key as string);
    } catch {
      return undefined;
    }
  }

  /**
   * Deletes a page for good (#2352 MC-03D).
   *
   * The confirmation has to carry the three facts an officer cannot see from the
   * card in front of them: which address disappears, whether that address is live
   * on the public site right now, and what else in the club's own content points
   * at it. The link references are computed from the list this panel already
   * holds — every page's body and intro text come down with it — so no extra
   * round trip is needed for the common case, and the endpoint's authoritative
   * report still drives the message afterwards in case the list was stale.
   */
  async function deletePage(page: EditablePageRecord) {
    if (deleteInFlightRef.current) {
      return;
    }
    deleteInFlightRef.current = page.id;

    try {
      // Same substring semantics the endpoint uses, so the dialog and the toast
      // cannot disagree: best-effort, and honest about it.
      const referencingSlugs = pages
        .filter(
          (other) =>
            other.id !== page.id &&
            ((other.contentHtml ?? "").includes(page.path) ||
              (other.headerText ?? "").includes(page.path)),
        )
        .map((other) => other.slug)
        .sort();
      // Two reads, in parallel: the two link surfaces the officer cannot see from
      // this card. Neither can stop the dialog opening — both answer undefined
      // when they fail, and the dialog then says nothing on that subject.
      const [bookNowTargetPageId, footerSectionKeys] = await Promise.all([
        loadBookNowTargetPageId(),
        loadFooterSectionsLinkingTo(page.path),
      ]);

      const description = [
        `${page.path} and its content will be removed permanently. This cannot be undone.`,
        page.published
          ? "The page is live on the public site now, so that address will start returning “page not found” straight away."
          : "The page is already hidden from the public site, so visitors will notice no change.",
        referencingSlugs.length > 0
          ? `Other pages link to it: ${referencingSlugs.join(", ")}. Those links will break.`
          : null,
        footerSectionKeys !== undefined && footerSectionKeys.length > 0
          ? `The site footer links to it (${describeFooterSections(footerSectionKeys)}), and the footer is on every public page. That link will break too.`
          : null,
        bookNowTargetPageId === page.id
          ? "The public Book Now button points at this page, so it will be set back to the booking flow."
          : null,
        "Hide it instead if you might want it back.",
      ]
        .filter((line): line is string => line !== null)
        .join(" ");

      if (
        !(await confirm({
          title: `Delete ${page.title}?`,
          description,
          confirmLabel: "Delete",
          destructive: true,
        }))
      ) {
        return;
      }

      setForbidden(false);
      const response = await fetch("/api/admin/page-content", {
        method: "DELETE",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: page.id }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        // The page-content routes' custom forbiddenResponse replies 401
        // ("Unauthorized") on permission denial, so treat 401 as forbidden
        // too — only authenticated admins can reach this panel.
        if (response.status === 403 || response.status === 401)
          setForbidden(true);
        throw new Error(body?.error ?? "Failed to delete page");
      }

      setPages((current) => current.filter((item) => item.id !== page.id));
      if (selectedPageId === page.id) {
        setDialogOpen(false);
        setSelectedPageId(null);
      }

      const referencedBySlugs = Array.isArray(body?.referencedBySlugs)
        ? (body.referencedBySlugs as string[])
        : [];
      const referencedByFooterSections = Array.isArray(
        body?.referencedByFooterSections,
      )
        ? (body.referencedByFooterSections as string[])
        : [];
      const consequences = [
        referencedBySlugs.length > 0
          ? `these pages still link to it: ${referencedBySlugs.join(", ")}`
          : null,
        referencedByFooterSections.length > 0
          ? `the site footer still links to it (${describeFooterSections(referencedByFooterSections)})`
          : null,
        // True as of the finding-1 fix: the endpoint moves the setting itself
        // inside the delete transaction, so this reports a change that happened
        // rather than describing a runtime fallback.
        body?.wasBookNowTarget === true
          ? "the Book Now button has been set back to the booking flow"
          : null,
        // The delete succeeded and the cache flush did not (finding 5). Worth the
        // officer's attention because the old address can keep answering for a
        // few minutes, and refreshing the public page is what proves it cleared.
        body?.publicCacheCleared === false
          ? "the public site's stored copy could not be cleared, so that address may keep answering for a few minutes"
          : null,
      ].filter((part): part is string => part !== null);

      if (consequences.length > 0) {
        toast.warning(`Deleted ${page.title} — ${consequences.join("; ")}.`);
      } else {
        toast.success(`Deleted ${page.title}`);
      }

      // Second review finding S2. The sibling PublicContentSettingsPanel loads
      // once on mount and posts its WHOLE settings object on save, so after this
      // delete it is holding two things that are no longer true: the published-page
      // list this page was in, and — when the delete repointed it — the stored
      // `bookNowTarget`/`bookNowPageId`. Its next save would then fail with
      // 400 "The selected Book Now page is not published." until the officer
      // happened to reload. Announced unconditionally: the page list goes stale on
      // every delete, not only on the ones that moved the Book Now target.
      emitPublicContentSettingsChanged();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to delete page",
      );
    } finally {
      deleteInFlightRef.current = null;
    }
  }

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
    setForbidden(false);
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
        // The page-content routes' custom forbiddenResponse replies 401
        // ("Unauthorized") on permission denial, so treat 401 as forbidden
        // too — only authenticated admins can reach this panel.
        if (response.status === 403 || response.status === 401)
          setForbidden(true);
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
    setForbidden(false);
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
        // The page-content routes' custom forbiddenResponse replies 401
        // ("Unauthorized") on permission denial, so treat 401 as forbidden
        // too — only authenticated admins can reach this panel.
        if (response.status === 403 || response.status === 401)
          setForbidden(true);
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

  /*
    #2160: the view-only explanation lives here, once, at the top of the section —
    announced on arrival and ahead of the controls it explains — instead of on
    each disabled button below. The `role="status"` wrapper is permanently
    mounted so the live region is registered in the accessibility tree before its
    content appears; a region injected already-populated is silently dropped by
    some screen-reader/browser pairings. It is rendered in the loading branch too
    so the region exists from the first paint rather than from whenever the page
    list settles.

    This panel lays out with per-child `mb-4` rather than a `space-y-*` stack, so
    the banner keeps its own `mb-4` and stays a direct child of the fragment —
    there is no spacing stack here to sit outside of.

    The Create Page and Save buttons inside the two dialogs are NOT opted out:
    dialog contents are a separate accessibility container this banner does not
    reach, so they keep their own per-button reason.
  */
  const viewOnlyBanner = (
    <AdminViewOnlySectionBanner canEdit={canEdit} className="mb-4">
      Your admin role can view page content but cannot change it. Pages open
      read-only and no save control is available.
    </AdminViewOnlySectionBanner>
  );

  if (loading) {
    return (
      <>
        {viewOnlyBanner}
        <p className="text-sm text-muted-foreground">Loading editable pages...</p>
      </>
    );
  }

  return (
    <>
      {viewOnlyBanner}
      {/* The delete confirmation's host. Mounted in the loaded branch only,
          because the Delete control it serves is rendered on the page cards
          below and there are none until the list arrives. */}
      {confirmDialog}
      {forbidden ? <AdminForbiddenSaveNotice className="mb-4" /> : null}
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
        <ViewOnlyActionButton
          canEdit={canEdit}
          describeReason={false}
          type="button"
          onClick={() => setAddDialogOpen(true)}
        >
          <Plus className="h-4 w-4" />
          Add Page
        </ViewOnlyActionButton>
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
          <div className="space-y-3 text-sm leading-6 text-muted-foreground">
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
            <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs text-foreground">
              {`.dynamic-header[data-page-slug="home"] {
    background: url('/api/images/uploaded/zzz.jpg') center / cover no-repeat;
}`}
            </pre>

            {/* Token documentation is rendered from the shared catalogue so
                this dialog stays in lockstep with the editor token help. */}
            <TokenCatalogueSections context="page-content-body" />
          </div>
        </DialogContent>
      </Dialog>

      <div className="grid gap-4 md:grid-cols-2">
        {pages.map((page) => {
          const textPreview = stripHtml(page.contentHtml);
          const hasContent = textPreview.length > 0;
          const isSystem = isSystemPageSlug(page.slug);
          const hasMenuTitle = page.menuTitle.trim().length > 0;
          // Only admin-created pages can be hidden; built-in/system pages stay
          // published because code routes, the footer, and the sitemap link them.
          const canHide = canUnpublishPage(page.slug);
          // Recovery affordance (#2440): a built-in page can only be hidden by
          // data no supported write produced (raw SQL, legacy rows), but since
          // the public routes now honour the flag — /home even 404s the site
          // root — the panel must offer a way back. The PATCH route only blocks
          // UNPUBLISHING protected pages; re-publishing is always accepted, so
          // showing the toggle whenever the page is hidden gives a one-click
          // repair without ever exposing a Hide button on a protected page.
          const showVisibilityToggle = canHide || !page.published;
          // Deletion is never wider than hiding (#2352 D-B3): the same predicate
          // the endpoint enforces, so a protected page shows no Delete control
          // rather than one that answers 422. Note the deliberate difference from
          // `showVisibilityToggle` above — that has a recovery arm for a hidden
          // built-in page, and there is nothing to recover by DELETING one.
          const showDelete = canDeletePage(page.slug);

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
                        className="text-[10px] uppercase text-muted-foreground"
                      >
                        System
                      </Badge>
                    )}
                    {!hasMenuTitle && (
                      <Badge
                        variant="outline"
                        className="text-[10px] uppercase text-muted-foreground"
                      >
                        No menu
                      </Badge>
                    )}
                    {!page.published && (
                      <Badge
                        variant="outline"
                        className="border-warning-6 text-[10px] uppercase text-warning-11"
                      >
                        Hidden
                      </Badge>
                    )}
                    <Badge variant={hasContent ? "default" : "secondary"}>
                      {hasContent ? "Has content" : "Empty"}
                    </Badge>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="text-xs text-muted-foreground">
                  Menu order: {page.sortOrder}
                </p>
                <p className="min-h-10 rounded-md border border-border bg-muted p-2 text-xs text-muted-foreground">
                  {hasContent
                    ? `${textPreview.slice(0, 180)}${textPreview.length > 180 ? "..." : ""}`
                    : "No content saved yet."}
                </p>
                <p className="text-xs text-muted-foreground">
                  Updated: {formatUpdatedAt(page.updatedAt)}
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button type="button" onClick={() => openEditor(page)}>
                    <Edit3 className="h-4 w-4" />
                    {canEdit ? "Edit" : "View"} {page.title}
                  </Button>
                  {showVisibilityToggle && (
                    <ViewOnlyActionButton
                      canEdit={canEdit}
                      describeReason={false}
                      type="button"
                      variant="outline"
                      onClick={() => togglePublished(page)}
                    >
                      {page.published ? (
                        <>
                          <EyeOff className="h-4 w-4" />
                          Hide
                        </>
                      ) : (
                        <>
                          <Eye className="h-4 w-4" />
                          Publish
                        </>
                      )}
                    </ViewOnlyActionButton>
                  )}
                  {showDelete && (
                    <ViewOnlyActionButton
                      canEdit={canEdit}
                      describeReason={false}
                      type="button"
                      variant="destructive"
                      onClick={() => void deletePage(page)}
                    >
                      <Trash2 className="h-4 w-4" />
                      Delete
                    </ViewOnlyActionButton>
                  )}
                </div>
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
              <p className="text-sm font-medium text-foreground">Slug</p>
              <Input
                value={newSlug}
                onChange={(event) =>
                  setNewSlug(event.target.value.trim().toLowerCase())
                }
                aria-label="Slug"
                {...newSlugHint.fieldProps}
              />
              <FieldHint {...newSlugHint.hintProps}>
                {`Example: trip-reports or join/apply. Path preview: /${newSlug || "your-page"}`}
              </FieldHint>
            </div>
            <div className="space-y-1">
              <p className="text-sm font-medium text-foreground">Menu order</p>
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
              <p className="text-sm font-medium text-foreground">Caption</p>
              <Input
                value={newCaption}
                onChange={(event) => setNewCaption(event.target.value)}
                aria-label="Caption"
                {...newCaptionHint.fieldProps}
              />
              <FieldHint {...newCaptionHint.hintProps}>
                Example: A practical alpine club
              </FieldHint>
            </div>
            <div className="space-y-1">
              <p className="text-sm font-medium text-foreground">Menu title</p>
              <Input
                value={newMenuTitle}
                onChange={(event) => setNewMenuTitle(event.target.value)}
                aria-label="Menu title"
                {...newMenuTitleHint.fieldProps}
              />
              <FieldHint {...newMenuTitleHint.hintProps}>
                Example: About
              </FieldHint>
            </div>
            <div className="space-y-1">
              <p className="text-sm font-medium text-foreground">Page title</p>
              <Input
                value={newTitle}
                onChange={(event) => setNewTitle(event.target.value)}
                aria-label="Page title"
                {...newTitleHint.fieldProps}
              />
              <FieldHint {...newTitleHint.hintProps}>
                Example: Trip Reports
              </FieldHint>
            </div>
            <div className="space-y-1">
              <p className="text-sm font-medium text-foreground">Header text</p>
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
              <ViewOnlyActionButton
                canEdit={canEdit}
                type="button"
                onClick={createPage}
                disabled={creating}
              >
                {creating ? "Creating..." : "Create Page"}
              </ViewOnlyActionButton>
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
              <div className="grid gap-3 rounded-md border border-border bg-muted p-3 md:grid-cols-2">
                <label className="space-y-1">
                  <span className="text-xs font-medium text-muted-foreground">
                    Slug
                    {isSystemPageSlug(selectedPage.slug) && (
                      <span className="ml-2 rounded bg-muted px-1 py-0.5 text-[10px] font-normal text-muted-foreground">
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
                    readOnly={isSystemPageSlug(selectedPage.slug) || !canEdit}
                    className={
                      isSystemPageSlug(selectedPage.slug) || !canEdit
                        ? "cursor-not-allowed bg-muted opacity-70"
                        : ""
                    }
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-xs font-medium text-muted-foreground">
                    Menu order
                    {isSystemPageSlug(selectedPage.slug) && (
                      <span className="ml-2 rounded bg-muted px-1 py-0.5 text-[10px] font-normal text-muted-foreground">
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
                    readOnly={isSystemPageSlug(selectedPage.slug) || !canEdit}
                    className={
                      isSystemPageSlug(selectedPage.slug) || !canEdit
                        ? "cursor-not-allowed bg-muted opacity-70"
                        : ""
                    }
                  />
                </label>
                <div className="md:col-span-2 text-xs text-muted-foreground">
                  Public path: /{draftSlug || "page-slug"}
                </div>
                <div className="md:col-span-2 grid grid-cols-3 gap-3">
                  <div className="space-y-1">
                    <label className="block space-y-1">
                      <span className="text-xs font-medium text-muted-foreground">
                        Caption
                      </span>
                      <Input
                        value={draftCaption}
                        onChange={(event) => setDraftCaption(event.target.value)}
                        readOnly={!canEdit}
                        {...draftCaptionHint.fieldProps}
                      />
                    </label>
                    <FieldHint {...draftCaptionHint.hintProps}>
                      Example: A practical alpine club
                    </FieldHint>
                  </div>
                  <div className="space-y-1">
                    <label className="block space-y-1">
                      <span className="text-xs font-medium text-muted-foreground">
                        Menu title
                      </span>
                      <Input
                        value={draftMenuTitle}
                        onChange={(event) =>
                          setDraftMenuTitle(event.target.value)
                        }
                        readOnly={!canEdit}
                        {...draftMenuTitleHint.fieldProps}
                      />
                    </label>
                    <FieldHint {...draftMenuTitleHint.hintProps}>
                      Example: About
                    </FieldHint>
                  </div>
                  <label className="space-y-1">
                    <span className="text-xs font-medium text-muted-foreground">
                      Page title
                    </span>
                    <Input
                      value={draftTitle}
                      onChange={(event) => setDraftTitle(event.target.value)}
                      placeholder="Page title"
                      readOnly={!canEdit}
                    />
                  </label>
                </div>
                <div className="space-y-1 md:col-span-2">
                  <span className="text-xs font-medium text-muted-foreground">
                    Header text
                  </span>
                  <WysiwygEditor
                    ref={headerEditorRef}
                    key={`header-${selectedPageId ?? "none"}`}
                    value={draftHeaderText}
                    onChange={setDraftHeaderText}
                    placeholder="Short intro text shown under the title"
                    editorClassName="min-h-28"
                    readOnly={!canEdit}
                    resolvingAccess={canEdit === undefined}
                  />
                </div>
              </div>

              {/* Header text renders raw (no token resolution), so only the
                  body editor gets token help. */}
              <WysiwygEditor
                ref={bodyEditorRef}
                key={selectedPageId ?? "none"}
                value={draftContent}
                onChange={setDraftContent}
                placeholder="Enter page HTML here"
                editorClassName="min-h-[320px]"
                tokenHelpContext="page-content-body"
                readOnly={!canEdit}
                resolvingAccess={canEdit === undefined}
              />

              <div className="rounded-md border border-border bg-muted p-3 text-xs text-muted-foreground">
                <p className="font-medium text-muted-foreground">Embed Tokens</p>
                <p className="mt-1">
                  Insert these in page body content using {"{{token}}"}. Legacy
                  single-brace {"{"}token{"}"} syntax remains accepted only for
                  non-photo tokens.
                </p>
                <p className="mt-1">
                  Photo tokens require double braces such as{" "}
                  {"{{photo-gallery}}"} or {"{{photo-slideshow}}"}.
                </p>
                <div className="mt-2">
                  <TokenChips
                    tokens={tokensForContext("page-content-body").map(
                      (definition) => ({ token: definition.token }),
                    )}
                  />
                </div>
                <p className="mt-2 text-[11px] text-muted-foreground">
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
                <ViewOnlyActionButton
                  canEdit={canEdit}
                  type="button"
                  onClick={saveContent}
                  disabled={saving}
                >
                  {saving ? (
                    <FileText className="h-4 w-4 animate-pulse" />
                  ) : (
                    <Save className="h-4 w-4" />
                  )}
                  {saving ? "Saving..." : "Save"}
                </ViewOnlyActionButton>
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
