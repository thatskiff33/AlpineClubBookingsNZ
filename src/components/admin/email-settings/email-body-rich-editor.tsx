"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  Heading2,
  Italic,
  List,
  ListOrdered,
  Underline,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { sanitiseEmailBodyHtml } from "@/lib/email-body-html";

/**
 * Rich in-place editor for admin email bodies (fork #38, owner decision
 * 25 Aug 2026: works like the /message-board composer). Follows
 * `club-post-editor.tsx`'s load-bearing patterns exactly — the sanitised
 * seed, selection saved on toolbar mousedown, and `styleWithCSS` false so
 * bold/italic/underline come out as tags the sanitiser allowlists rather
 * than style spans it would strip.
 *
 * WHAT THIS PRODUCES IS NOT TRUSTED: the server sanitises on save against
 * `email-body-html.ts` and again at render, and that policy is the control.
 * The toolbar deliberately offers only what the policy keeps —
 * bold/italic/underline, a heading, lists, alignment. No colours, fonts, sizes, images
 * or links: emails stay on the club theme in every mail client. `{{token}}`
 * markers are ordinary text in here; type them (or re-use the chips above
 * the editor) exactly as in the old plain editor.
 */
export function EmailBodyRichEditor({
  value,
  onChange,
  disabled,
  id,
  ariaLabel = "Email body",
}: {
  value: string;
  onChange: (html: string) => void;
  disabled: boolean;
  id?: string;
  /** Accessible name — a contentEditable div is not a labelable control, so
   * the visible <Label> cannot reach it via htmlFor; this carries the name. */
  ariaLabel?: string;
}) {
  const editorRef = useRef<HTMLDivElement | null>(null);
  const savedRange = useRef<Range | null>(null);
  // What THIS editor last reported upward. Distinguishes "value changed
  // because of my own keystroke" (skip the reseed, keep the caret) from
  // "value changed externally" — a template switch, a reset, or load()
  // returning the server's SANITISED copy after a save. The external case
  // reseeds unconditionally, which is what keeps the surface truthful:
  // content the save stripped (a pasted image, a colour) disappears from the
  // screen too, instead of lingering as something the admin believes was
  // stored (drift lens finding 5 — the old sanitise-equality guard
  // suppressed exactly that correction).
  const lastEmitted = useRef<string | null>(null);
  const [seed, setSeed] = useState(() => sanitiseEmailBodyHtml(value));

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    if (lastEmitted.current !== null && value === lastEmitted.current) return;
    const safe = sanitiseEmailBodyHtml(value);
    if (editor.innerHTML !== safe) {
      editor.innerHTML = safe;
      setSeed(safe);
    }
    lastEmitted.current = null;
  }, [value]);

  const saveSelection = useCallback(() => {
    const editor = editorRef.current;
    const selection = window.getSelection();
    if (!editor || !selection || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    if (editor.contains(range.commonAncestorContainer)) {
      savedRange.current = range.cloneRange();
    }
  }, []);

  const restoreSelection = useCallback(() => {
    const editor = editorRef.current;
    const selection = window.getSelection();
    if (!editor || !selection || !savedRange.current) return;
    const current = selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
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
    lastEmitted.current = html;
    onChange(html);
  }, [onChange]);

  // Paste arrives sanitised, so disallowed markup never even ENTERS the
  // editing surface — the guide promise that pasted colours, fonts and
  // pictures are dropped is then true of the screen, not only of storage
  // (drift lens finding 5).
  const handlePaste = useCallback(
    (event: React.ClipboardEvent<HTMLDivElement>) => {
      event.preventDefault();
      const richClip = event.clipboardData.getData("text/html");
      if (richClip) {
        document.execCommand(
          "insertHTML",
          false,
          sanitiseEmailBodyHtml(richClip),
        );
      } else {
        document.execCommand(
          "insertText",
          false,
          event.clipboardData.getData("text/plain"),
        );
      }
      emit();
    },
    [emit],
  );

  const run = useCallback(
    (command: string, commandValue?: string) => {
      if (disabled) return;
      editorRef.current?.focus();
      restoreSelection();
      // styleWithCSS FALSE is load-bearing (see club-post-editor.tsx): as
      // tags (<b>, <i>, <u>) the formats survive the sanitiser's allowlist;
      // as style spans they would be stripped by our own policy.
      document.execCommand("styleWithCSS", false, "false");
      document.execCommand(command, false, commandValue);
      emit();
    },
    [disabled, emit, restoreSelection],
  );

  // Heading toggle (drift lens finding 8): without this, the <h2> the
  // lossless upgrade preserves would be content nobody could recreate.
  const toggleHeading = useCallback(() => {
    const selection = window.getSelection();
    const anchor = selection ? selection.anchorNode : null;
    const element =
      anchor instanceof Element ? anchor : anchor ? anchor.parentElement : null;
    const inHeading = Boolean(element && element.closest("h2"));
    run("formatBlock", inHeading ? "<p>" : "<h2>");
  }, [run]);

  const controls: Array<{
    label: string;
    icon: React.ReactNode;
    command?: string;
    special?: "heading";
  }> = [
    { label: "Bold", icon: <Bold className="h-4 w-4" />, command: "bold" },
    { label: "Italic", icon: <Italic className="h-4 w-4" />, command: "italic" },
    {
      label: "Underline",
      icon: <Underline className="h-4 w-4" />,
      command: "underline",
    },
    {
      label: "Heading",
      icon: <Heading2 className="h-4 w-4" />,
      special: "heading",
    },
    {
      label: "Bullet list",
      icon: <List className="h-4 w-4" />,
      command: "insertUnorderedList",
    },
    {
      label: "Numbered list",
      icon: <ListOrdered className="h-4 w-4" />,
      command: "insertOrderedList",
    },
    {
      label: "Align left",
      icon: <AlignLeft className="h-4 w-4" />,
      command: "justifyLeft",
    },
    {
      label: "Align centre",
      icon: <AlignCenter className="h-4 w-4" />,
      command: "justifyCenter",
    },
    {
      label: "Align right",
      icon: <AlignRight className="h-4 w-4" />,
      command: "justifyRight",
    },
  ];

  return (
    <div className="mt-1 rounded-md border">
      <div className="flex flex-wrap items-center gap-1 border-b p-1">
        {controls.map((control) => (
          <Button
            key={control.label}
            type="button"
            size="sm"
            variant="outline"
            className="h-7 px-2"
            aria-label={control.label}
            title={control.label}
            disabled={disabled}
            onMouseDown={(event) => {
              // Focus-stealing on mousedown collapses the selection before
              // click ever fires; preventing it keeps the caret in place.
              event.preventDefault();
              saveSelection();
              if (control.special === "heading") toggleHeading();
              else if (control.command) run(control.command);
            }}
          >
            {control.icon}
          </Button>
        ))}
        <span className="ml-1 text-xs text-muted-foreground">
          Styling shows as you type; tokens like {"{{firstName}}"} stay plain
          text.
        </span>
      </div>
      <div
        ref={editorRef}
        id={id}
        role="textbox"
        aria-multiline="true"
        aria-label={ariaLabel}
        aria-readonly={disabled || undefined}
        contentEditable={!disabled}
        suppressContentEditableWarning
        className={
          disabled
            ? "min-h-72 cursor-not-allowed bg-muted px-3 py-2 text-sm opacity-60"
            : "min-h-72 px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        }
        onPaste={handlePaste}
        onInput={emit}
        onBlur={saveSelection}
        onKeyUp={saveSelection}
        onMouseUp={saveSelection}
        // The seed is ALWAYS the output of sanitiseEmailBodyHtml (mount and
        // every reseed above), the same policy the server enforces on save
        // and render — the club-post-editor precedent (#2992).
        dangerouslySetInnerHTML={{ __html: seed }} /* nosemgrep: typescript.react.security.audit.react-dangerouslysetinnerhtml.react-dangerouslysetinnerhtml */
      />
    </div>
  );
}
