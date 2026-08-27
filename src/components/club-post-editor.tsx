"use client";

import { useCallback, useRef, useState } from "react";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  Image as ImageIcon,
  Italic,
  List,
  ListOrdered,
  Underline,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  POST_COLOURS,
  POST_FONT_FAMILIES,
  POST_FONT_SIZES,
  sanitiseClubPostHtml,
} from "@/lib/club-post-html";

/**
 * Rich composer for the club message board (epic #2992).
 *
 * DELIBERATELY NOT `components/admin/page-content-panel.tsx`'s WysiwygEditor.
 * That one is an ADMIN component: it carries token help, an HTML source
 * toggle, and view-only-admin semantics that make no sense for a member
 * writing a post, and it is already 2,500 lines. Reusing it would have meant
 * threading member concerns through an admin surface and growing a file that
 * is far over its size budget. This is the member-facing half, with only the
 * controls the owner asked for.
 *
 * WHAT THIS PRODUCES IS NOT TRUSTED. Everything here is convenience; the
 * server sanitises the submitted HTML against `club-post-html.ts` and that is
 * the control. The toolbar is built from the same exported allowlists, so the
 * composer cannot offer a colour or size the sanitiser would silently drop.
 */

interface ClubPostEditorProps {
  value: string;
  onChange: (html: string) => void;
  disabled?: boolean;
  placeholder?: string;
  /** Surfaced by the composer so an upload failure is not silent. */
  onImageError?: (message: string) => void;
}

/**
 * One toolbar control.
 *
 * A COMPONENT rather than a function called during render: the callbacks reach
 * the editor's refs, and a helper invoked inline makes that look like a ref
 * read during render (react-hooks/refs). As a component the callback is a prop
 * and only ever runs from the event.
 *
 * onMouseDown with preventDefault, never onClick: a button takes focus on
 * mousedown, which collapses the member's selection before any click handler
 * could apply a command to it.
 */
function ToolbarButton({
  label,
  icon,
  disabled,
  onRun,
}: {
  label: string;
  icon: React.ReactNode;
  disabled: boolean;
  onRun: () => void;
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      className="h-7 px-2"
      aria-label={label}
      title={label}
      disabled={disabled}
      onMouseDown={(event) => {
        event.preventDefault();
        onRun();
      }}
    >
      {icon}
    </Button>
  );
}

export function ClubPostEditor({
  value,
  onChange,
  disabled = false,
  placeholder = "Share something with the club…",
  onImageError,
}: ClubPostEditorProps) {
  const editorRef = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  // The selection as it stood before a toolbar dropdown took focus. Opening
  // a <select> collapses the editor's selection, so without this a colour
  // or size chosen from a dropdown applied to NOTHING -- the member picked
  // red, nothing happened, and nothing said why.
  const savedRange = useRef<Range | null>(null);
  const [uploading, setUploading] = useState(false);
  const [empty, setEmpty] = useState(value.trim() === "");

  // The seed, through the SAME allowlist as every rendered body. Today's
  // callers only ever pass "", but this component's API accepts HTML, and an
  // editor that trusted its seed would become the one unsanitised sink the
  // moment an edit flow passes stored content in.
  const safeSeed = sanitiseClubPostHtml(value);

  const saveSelection = useCallback(() => {
    const editor = editorRef.current;
    const selection = window.getSelection();
    if (!editor || !selection || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    if (editor.contains(range.commonAncestorContainer)) {
      savedRange.current = range.cloneRange();
    }
  }, []);

  /** Put the saved selection back when focus-stealing collapsed the live one. */
  const restoreSelection = useCallback(() => {
    const editor = editorRef.current;
    const selection = window.getSelection();
    if (!editor || !selection || !savedRange.current) return;
    const current =
      selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
    const usable =
      current &&
      !current.collapsed &&
      editor.contains(current.commonAncestorContainer);
    if (!usable) {
      selection.removeAllRanges();
      selection.addRange(savedRange.current);
    }
  }, []);

  const emit = useCallback(() => {
    const html = editorRef.current?.innerHTML ?? "";
    setEmpty(editorRef.current?.textContent?.trim() === "" && !html.includes("<img"));
    onChange(html);
  }, [onChange]);

  /**
   * Run a command without losing the selection.
   *
   * A toolbar button takes focus on mousedown, which collapses the selection
   * before the click handler ever runs — so the command applies to nothing.
   * Preventing the default on mousedown keeps the caret where the member left
   * it, which is why every control below uses onMouseDown rather than onClick.
   */
  const run = useCallback(
    (command: string, value?: string) => {
      if (disabled) return;
      editorRef.current?.focus();
      restoreSelection();
      // styleWithCSS is FALSE, and this line is load-bearing: with it true,
      // the browser emits bold as `<span style="font-weight:bold">`, and the
      // sanitiser's style allowlist (colour/size/family/alignment only)
      // strips that declaration -- so bold, italic and underline were being
      // destroyed by the composer's own sanitise pass before ever being
      // stored. As tags (<b>, <i>, <u>) they are allowlisted and survive.
      // Alignment still comes out as a text-align style either way.
      document.execCommand("styleWithCSS", false, "false");
      document.execCommand(command, false, value);
      emit();
    },
    [disabled, emit, restoreSelection],
  );

  /**
   * Wrap the selection in a span carrying one of the post_message_* colour
   * classes. A CLASS rather than an inline style because the browser
   * serialises style colours to rgb() form, which is how every colour a
   * member picked was being dropped by the hex-only sanitiser: the class
   * has one spelling on both sides. The colours themselves live in
   * globals.css, per theme.
   */
  const applyColourClass = useCallback(
    (className: string) => {
      if (disabled) return;
      const editor = editorRef.current;
      if (!editor) return;
      editor.focus();
      restoreSelection();

      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0) return;
      const range = selection.getRangeAt(0);
      if (range.collapsed) return;
      if (!editor.contains(range.commonAncestorContainer)) return;

      const span = document.createElement("span");
      if (className) span.className = className;
      span.appendChild(range.extractContents());
      range.insertNode(span);

      selection.removeAllRanges();
      const after = document.createRange();
      after.selectNodeContents(span);
      selection.addRange(after);

      emit();
    },
    [disabled, emit, restoreSelection],
  );

  /**
   * Wrap the selection in a styled span.
   *
   * Not `execCommand("fontSize")`: that emits either a `<font>` element or a
   * CSS keyword like `large`, and neither is on the allowlist — the member
   * would see the change and then watch the server drop it. Extract-and-insert
   * rather than `surroundContents`, which throws when the selection crosses an
   * element boundary (selecting across two paragraphs, say).
   */
  const applyStyle = useCallback(
    (property: string, cssValue: string) => {
      if (disabled) return;
      const editor = editorRef.current;
      if (!editor) return;
      editor.focus();
      restoreSelection();

      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0) return;
      const range = selection.getRangeAt(0);
      if (range.collapsed) return;
      // Refuse to style anything outside this editor.
      if (!editor.contains(range.commonAncestorContainer)) return;

      const span = document.createElement("span");
      if (cssValue) span.style.setProperty(property, cssValue);
      span.appendChild(range.extractContents());
      range.insertNode(span);

      // Leave the newly styled run selected, so a member can apply a colour and
      // a size to the same words without reselecting between them.
      selection.removeAllRanges();
      const after = document.createRange();
      after.selectNodeContents(span);
      selection.addRange(after);

      emit();
    },
    [disabled, emit, restoreSelection],
  );

  const insertImage = useCallback(
    async (file: File) => {
      // Client half of the six-image cap (#3091 review 3). The server
      // enforces it on upload and again on post; this stops the seventh
      // click before an upload round-trip, with the reason in words.
      const imagesInDraft =
        editorRef.current?.querySelectorAll("img").length ?? 0;
      if (imagesInDraft >= 6) {
        onImageError?.("A post can carry at most 6 images.");
        return;
      }
      setUploading(true);
      try {
        const body = new FormData();
        body.append("file", file);
        const res = await fetch("/api/club-posts/images", {
          method: "POST",
          body,
        });
        const payload = (await res.json().catch(() => null)) as {
          url?: string;
          error?: string;
        } | null;
        if (!res.ok || !payload?.url) {
          onImageError?.(payload?.error ?? "That image could not be added.");
          return;
        }
        // alt is empty and the image is decorative-by-default rather than
        // guessing a description from the filename, which is usually
        // "IMG_4821.JPG" and tells a screen reader nothing.
        run("insertHTML", `<img src="${payload.url}" alt="" />`);
      } catch {
        onImageError?.("That image could not be added.");
      } finally {
        setUploading(false);
      }
    },
    [onImageError, run],
  );

  const selectClass =
    "h-7 rounded-md border border-input bg-background px-1 text-xs disabled:opacity-60";

  return (
    <div className="rounded-md border border-input">
      <div className="flex flex-wrap items-center gap-1 border-b border-input p-1">
        <select
          className={selectClass}
          aria-label="Paragraph style"
          disabled={disabled}
          defaultValue=""
          onMouseDown={saveSelection}
          onChange={(event) => {
            if (event.target.value) run("formatBlock", event.target.value);
            event.target.value = "";
          }}
        >
          <option value="">Style</option>
          <option value="P">Normal text</option>
          <option value="H1">Heading 1</option>
          <option value="H2">Heading 2</option>
          <option value="H3">Heading 3</option>
        </select>

        <select
          className={selectClass}
          aria-label="Font"
          disabled={disabled}
          defaultValue=""
          onMouseDown={saveSelection}
          onChange={(event) => {
            applyStyle("font-family", event.target.value);
            event.target.value = "";
          }}
        >
          <option value="">Font</option>
          {POST_FONT_FAMILIES.filter((f) => f.value).map((font) => (
            <option key={font.value} value={font.value}>
              {font.label}
            </option>
          ))}
        </select>

        <select
          className={selectClass}
          aria-label="Font size"
          disabled={disabled}
          defaultValue=""
          onMouseDown={saveSelection}
          onChange={(event) => {
            applyStyle("font-size", event.target.value);
            event.target.value = "";
          }}
        >
          <option value="">Size</option>
          {POST_FONT_SIZES.map((size) => (
            <option key={size} value={`${size}pt`}>
              {size}
            </option>
          ))}
        </select>

        <select
          className={selectClass}
          aria-label="Text colour"
          disabled={disabled}
          defaultValue=""
          onMouseDown={saveSelection}
          onChange={(event) => {
            applyColourClass(event.target.value);
            event.target.value = "";
          }}
        >
          <option value="">Colour</option>
          {POST_COLOURS.filter((c) => c.className).map((colour) => (
            <option key={colour.className} value={colour.className}>
              {colour.label}
            </option>
          ))}
        </select>

        <ToolbarButton label="Bold" icon={<Bold className="h-4 w-4" />} disabled={disabled} onRun={() => run("bold")} />
        <ToolbarButton label="Italic" icon={<Italic className="h-4 w-4" />} disabled={disabled} onRun={() => run("italic")} />
        <ToolbarButton label="Underline" icon={<Underline className="h-4 w-4" />} disabled={disabled} onRun={() => run("underline")} />

        <ToolbarButton label="Align left" icon={<AlignLeft className="h-4 w-4" />} disabled={disabled} onRun={() => run("justifyLeft")} />
        <ToolbarButton label="Align centre" icon={<AlignCenter className="h-4 w-4" />} disabled={disabled} onRun={() => run("justifyCenter")} />
        <ToolbarButton label="Align right" icon={<AlignRight className="h-4 w-4" />} disabled={disabled} onRun={() => run("justifyRight")} />
        {/* Justified alignment removed at the owner's request (24 Aug 2026). The
            sanitiser still ACCEPTS text-align:justify, deliberately: posts written
            while the button existed, and mirrored posts from clubs whose composer
            still offers it, must keep rendering as authored. */}
        
        <ToolbarButton label="Bulleted list" icon={<List className="h-4 w-4" />} disabled={disabled} onRun={() => run("insertUnorderedList")} />
        <ToolbarButton label="Numbered list" icon={<ListOrdered className="h-4 w-4" />} disabled={disabled} onRun={() => run("insertOrderedList")} />

        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7 px-2"
          aria-label="Add image"
          title="Add image"
          disabled={disabled || uploading}
          onMouseDown={(event) => {
            event.preventDefault();
            fileRef.current?.click();
          }}
        >
          <ImageIcon className="h-4 w-4" />
          {uploading ? <span className="ml-1 text-xs">Adding…</span> : null}
        </Button>
        <input
          ref={fileRef}
          type="file"
          className="hidden"
          accept="image/jpeg,image/png,image/webp"
          onChange={(event) => {
            const file = event.target.files?.[0];
            // Cleared straight away so picking the SAME file twice still fires
            // a change event.
            event.target.value = "";
            if (file) void insertImage(file);
          }}
        />
      </div>

      <div className="relative">
        {empty ? (
          <p className="pointer-events-none absolute left-3 top-3 text-sm text-muted-foreground">
            {placeholder}
          </p>
        ) : null}
        <div
          ref={editorRef}
          role="textbox"
          aria-multiline="true"
          aria-label="Post"
          contentEditable={!disabled}
          suppressContentEditableWarning
          onInput={emit}
          onBlur={emit}
          className="min-h-32 w-full px-3 py-2 text-sm text-foreground outline-none [&_blockquote]:border-l-4 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_h1]:mb-2 [&_h1]:mt-3 [&_h1]:text-2xl [&_h1]:font-bold [&_h2]:mb-2 [&_h2]:mt-3 [&_h2]:text-xl [&_h2]:font-bold [&_h3]:mb-1 [&_h3]:mt-2 [&_h3]:text-lg [&_h3]:font-semibold [&_img]:my-2 [&_img]:max-w-full [&_img]:rounded [&_li]:my-1 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-6 [&_p]:my-1 [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-6"
          // Set once, uncontrolled thereafter: rewriting innerHTML on every
          // keystroke would move the caret to the start of the field on every
          // character typed.
          /* Member HTML, but the seed is sanitised through the board allowlist above, and today's only caller passes the empty string. */
          dangerouslySetInnerHTML={{ __html: safeSeed }} /* nosemgrep: typescript.react.security.audit.react-dangerouslysetinnerhtml.react-dangerouslysetinnerhtml */
        />
      </div>
    </div>
  );
}
