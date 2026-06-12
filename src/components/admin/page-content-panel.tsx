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
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  ArrowRight,
  Edit3,
  FileText,
  ListOrdered,
  List,
  Plus,
  Save,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { Label } from "../ui/label";

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

const HOME_EMBED_TOKENS = [
  "committee-members-cards",
  "member-application-form",
  "contact-form",
  "join-apply-form",
] as const;

type WysiwygEditorHandle = {
  getHtml: () => string;
};

const WysiwygEditor = forwardRef<
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
  const [imageFilter, setImageFilter] = useState("");
  const [selectedImagePath, setSelectedImagePath] = useState("");
  const [mountTick, setMountTick] = useState(0);
  const editorDivRef = useRef<HTMLDivElement | null>(null);
  const selectionRef = useRef<Range | null>(null);
  const debounceRef = useRef<number | null>(null);

  const filteredSiteImages = useMemo(() => {
    const needle = imageFilter.trim().toLowerCase();
    if (!needle) {
      return siteImages;
    }
    return siteImages.filter((img) => img.toLowerCase().includes(needle));
  }, [imageFilter, siteImages]);

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

  useEffect(() => {
    if (!imagePickerOpen) {
      return;
    }

    let cancelled = false;
    setLoadingSiteImages(true);

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
        setSelectedImagePath((current) => current || nextImages[0] || "");
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

    return () => {
      cancelled = true;
    };
  }, [imagePickerOpen]);

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
    setImagePickerOpen(true);
  }

  function insertSelectedImage() {
    if (!selectedImagePath) {
      return;
    }
    runCommand("insertImage", selectedImagePath);
    setImagePickerOpen(false);
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
          className={`${editorClassName} overflow-y-auto rounded-md border border-slate-300 bg-white p-3 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-400 [&_a]:text-blue-700 [&_a]:underline [&_a]:decoration-blue-400 [&_b]:font-bold [&_blockquote]:my-3 [&_blockquote]:border-l-4 [&_blockquote]:border-slate-300 [&_blockquote]:pl-3 [&_blockquote]:italic [&_code]:rounded [&_code]:bg-slate-100 [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_em]:italic [&_h1]:mt-4 [&_h1]:mb-2 [&_h1]:text-3xl [&_h1]:font-bold [&_h2]:mt-4 [&_h2]:mb-2 [&_h2]:text-2xl [&_h2]:font-bold [&_h3]:mt-3 [&_h3]:mb-2 [&_h3]:text-xl [&_h3]:font-semibold [&_hr]:my-4 [&_hr]:border-slate-300 [&_i]:italic [&_li]:my-1 [&_ol]:my-3 [&_ol]:list-decimal [&_ol]:pl-6 [&_p]:my-2 [&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-slate-100 [&_pre]:p-3 [&_pre]:font-mono [&_strong]:font-bold [&_table]:my-3 [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:border-slate-300 [&_td]:p-2 [&_th]:border [&_th]:border-slate-300 [&_th]:bg-slate-100 [&_th]:p-2 [&_u]:underline [&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-6`}
        />
      )}

      <div className="space-y-2">
        <Label>Tokens</Label>
        <div className="flex flex-wrap gap-2">
          {HOME_EMBED_TOKENS.map((token) => (
            <Badge key={token} variant="outline">
              {`{{${token}}}`}
            </Badge>
          ))}
        </div>
      </div>

      <Dialog open={imagePickerOpen} onOpenChange={setImagePickerOpen}>
        <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Insert Image From Site</DialogTitle>
            <DialogDescription>
              Pick an image from the site&apos;s public directory.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <Input
              value={imageFilter}
              onChange={(event) => setImageFilter(event.target.value)}
              placeholder="Filter images by path"
            />

            <div className="max-h-64 overflow-y-auto rounded-md border border-slate-200">
              {loadingSiteImages ? (
                <p className="p-3 text-sm text-slate-500">Loading images...</p>
              ) : filteredSiteImages.length === 0 ? (
                <p className="p-3 text-sm text-slate-500">
                  No images found in public/.
                </p>
              ) : (
                <div className="divide-y divide-slate-200">
                  {filteredSiteImages.map((imgPath) => (
                    <button
                      key={imgPath}
                      type="button"
                      onClick={() => setSelectedImagePath(imgPath)}
                      className={`w-full px-3 py-2 text-left text-sm transition-colors hover:bg-slate-50 ${
                        selectedImagePath === imgPath
                          ? "bg-slate-100 font-medium text-slate-900"
                          : "text-slate-700"
                      }`}
                    >
                      {imgPath}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {selectedImagePath ? (
              <div className="space-y-2 rounded-md border border-slate-200 p-3">
                <p className="text-xs text-slate-500">Preview</p>
                <img
                  src={selectedImagePath}
                  alt="Selected site image"
                  className="max-h-52 w-auto rounded border border-slate-200"
                />
                <p className="truncate text-xs text-slate-600">
                  {selectedImagePath}
                </p>
              </div>
            ) : null}

            <div className="flex justify-end gap-2">
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
    </div>
  );
});

export function PageContentPanel() {
  const [pages, setPages] = useState<EditablePageRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [creating, setCreating] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
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
  const isSystemNotFoundPage = selectedPage?.path === "/404";
  const isSystemHomePage = selectedPage?.path === "/home";
  const isSystemPage = isSystemNotFoundPage || isSystemHomePage;

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
    setDraftSortOrder(page.sortOrder);
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

    if (slug === "404") {
      toast.error(
        "The 404 page is a system page. Edit the existing /404 card instead of creating a new page.",
      );
      return;
    }

    if (slug === "home") {
      toast.error(
        "The home page is a system page. Edit the existing /home card instead of creating a new page.",
      );
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

  async function deleteSelectedPage() {
    if (!selectedPage) {
      return;
    }

    setDeleting(true);
    try {
      const response = await fetch("/api/admin/page-content", {
        method: "DELETE",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: selectedPage.id }),
      });

      const body = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(body?.error ?? "Failed to delete page");
      }

      setPages((current) =>
        current.filter((page) => page.id !== selectedPage.id),
      );
      setSelectedPageId(null);
      setDeleteDialogOpen(false);
      setDialogOpen(false);
      toast.success(`${selectedPage.title} deleted`);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to delete page",
      );
    } finally {
      setDeleting(false);
    }
  }

  if (loading) {
    return <p className="text-sm text-slate-500">Loading editable pages...</p>;
  }

  return (
    <>
      <div className="mb-4 flex items-center justify-end">
        <Button type="button" onClick={() => setAddDialogOpen(true)}>
          <Plus className="h-4 w-4" />
          Add Page
        </Button>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {pages.map((page) => {
          const textPreview = stripHtml(page.contentHtml);
          const hasContent = textPreview.length > 0;

          return (
            <Card key={page.slug}>
              <CardHeader>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <CardTitle>{page.title}</CardTitle>
                    <CardDescription>{page.path}</CardDescription>
                  </div>
                  <div className="flex items-center gap-2">
                    {page.path === "/404" || page.path === "/home" ? (
                      <Badge variant="outline">System</Badge>
                    ) : null}
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
                  </span>
                  <Input
                    value={draftSlug}
                    onChange={(event) =>
                      setDraftSlug(event.target.value.trim().toLowerCase())
                    }
                    placeholder="page-slug"
                    disabled={isSystemPage}
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-xs font-medium text-slate-700">
                    Menu order
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
                  />
                </label>
                <div className="md:col-span-2 text-xs text-slate-600">
                  Public path: /{draftSlug || "page-slug"}
                </div>
                {isSystemNotFoundPage ? (
                  <div className="md:col-span-2 rounded-md border border-slate-300 bg-slate-100 p-2 text-xs text-slate-700">
                    This is the system 404 page. Its slug/path and menu title
                    are locked.
                  </div>
                ) : isSystemHomePage ? (
                  <div className="md:col-span-2 rounded-md border border-slate-300 bg-slate-100 p-2 text-xs text-slate-700">
                    This is the system home page. Its slug/path and menu title
                    are locked.
                  </div>
                ) : null}
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
                      disabled={isSystemPage}
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

              <div className="flex items-center justify-between gap-2">
                <Button
                  type="button"
                  variant="destructive"
                  onClick={() => setDeleteDialogOpen(true)}
                  disabled={saving || deleting || isSystemPage}
                >
                  <Trash2 className="h-4 w-4" />
                  Delete
                </Button>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setDialogOpen(false)}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    onClick={saveContent}
                    disabled={saving || deleting}
                  >
                    {saving ? (
                      <FileText className="h-4 w-4 animate-pulse" />
                    ) : (
                      <Save className="h-4 w-4" />
                    )}
                    {saving ? "Saving..." : "Save"}
                  </Button>
                </div>
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete Page?</DialogTitle>
            <DialogDescription>
              {selectedPage
                ? `This will permanently delete ${selectedPage.title} (${selectedPage.path}). This action cannot be undone.`
                : "This will permanently delete this page. This action cannot be undone."}
            </DialogDescription>
          </DialogHeader>

          <div className="flex justify-end gap-2 pt-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => setDeleteDialogOpen(false)}
              disabled={deleting}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={deleteSelectedPage}
              disabled={deleting}
            >
              {deleting ? "Deleting..." : "Confirm Delete"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
