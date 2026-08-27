"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { ClubPostEditor } from "@/components/club-post-editor";
import {
  clubPostHtmlToText,
  sanitiseClubPostHtml,
} from "@/lib/club-post-html";

/**
 * The club message board composer (#2994, rich editor added under epic #2992).
 *
 * The member writes formatted text and may add images; both the HTML and its
 * plain-text form are sent, and the SERVER sanitises the HTML again and
 * re-derives the text. Nothing here is trusted — this pass exists so the
 * counter and the disabled state agree with what will actually be stored,
 * rather than letting a member fill the limit with markup they cannot see.
 */
export function ClubPostComposer({
  maxLength,
  canShareToAllClubs = false,
}: {
  maxLength: number;
  /**
   * Whether this club can share beyond itself. Off unless the central-server
   * integration is configured, because a tickbox that cannot do anything is
   * worse than no tickbox: a member ticks it, posts, and reasonably believes
   * other clubs can see it.
   */
  canShareToAllClubs?: boolean;
}) {
  const router = useRouter();
  const [html, setHtml] = useState("");
  const [shareToAllClubs, setShareToAllClubs] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [saving, setSaving] = useState(false);
  const [editorKey, setEditorKey] = useState(0);

  // Measured on the TEXT, not the markup: a member should not be told they are
  // over the limit because a heading and a colour cost characters they cannot
  // see.
  const text = clubPostHtmlToText(html);
  const hasImage = html.includes("<img");
  const tooLong = text.length > maxLength;
  const canPost =
    (text.length > 0 || hasImage) && !tooLong && !saving && !pending;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!canPost) return;

    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/club-posts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        // The author is taken from the session on the server; a name in this
        // body would be ignored, so it is not sent. The server sanitises
        // `bodyHtml` again and re-derives `content` from it — what is sent here
        // is a proposal, not a record.
        body: JSON.stringify({
          content: text,
          bodyHtml: sanitiseClubPostHtml(html),
          shareToAllClubs: canShareToAllClubs && shareToAllClubs,
        }),
      });

      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(payload?.error ?? "That post could not be saved.");
      }

      setHtml("");
      setShareToAllClubs(false);
      // Remounts the contentEditable so it actually empties. The editor is
      // uncontrolled after mount — rewriting its innerHTML on every keystroke
      // would send the caret to the start of the field — so clearing the state
      // alone would leave the old text on screen.
      setEditorKey((key) => key + 1);
      // Re-render the server component so the new post appears as the server
      // actually stored it, rather than a local guess at it.
      startTransition(() => router.refresh());
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "That post could not be saved.",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="space-y-2">
        <Label htmlFor="club-post-content">Write to the club</Label>
        <div id="club-post-content">
          <ClubPostEditor
            key={editorKey}
            value=""
            onChange={setHtml}
            disabled={saving || pending}
            onImageError={setError}
          />
        </div>
        <p
          id="club-post-counter"
          className={`text-xs ${tooLong ? "text-destructive" : "text-muted-foreground"}`}
        >
          {text.length} of {maxLength} characters
          {tooLong ? " — too long to post" : ""}
        </p>
      </div>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <input
            type="checkbox"
            checked={canShareToAllClubs && shareToAllClubs}
            disabled={!canShareToAllClubs || saving || pending}
            onChange={(event) => setShareToAllClubs(event.target.checked)}
            aria-describedby="club-post-share-note"
          />
          Share with all clubs
        </label>
        <Button type="submit" disabled={!canPost}>
          {saving || pending ? "Posting…" : "Post"}
        </Button>
      </div>
      <p id="club-post-share-note" className="text-xs text-muted-foreground">
        {canShareToAllClubs
          ? "Shared posts are sent to the central server and appear on every club's board. Your own club's posts stay here unless you tick this."
          : "Sharing beyond your own club is not set up for this club, so every post stays here."}
      </p>
    </form>
  );
}
