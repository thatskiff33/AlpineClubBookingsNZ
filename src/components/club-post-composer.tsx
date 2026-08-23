"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

/**
 * The club message board composer (#2994).
 *
 * Deliberately small: a textarea, a counter, a disabled share control and a
 * button. The share tickbox is rendered NOW, switched off and disabled, so the
 * form does not grow a new control out of nowhere when sharing lands in a later
 * child of epic #2992 — members meet the idea before it does anything.
 */
export function ClubPostComposer({ maxLength }: { maxLength: number }) {
  const router = useRouter();
  const [content, setContent] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [saving, setSaving] = useState(false);

  const trimmed = content.trim();
  const tooLong = trimmed.length > maxLength;
  const canPost = trimmed.length > 0 && !tooLong && !saving && !pending;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!canPost) return;

    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/club-posts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        // Only the text is sent. The author is taken from the session on the
        // server; a name in this body would be ignored, so it is not sent.
        body: JSON.stringify({ content: trimmed }),
      });

      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(payload?.error ?? "That post could not be saved.");
      }

      setContent("");
      // Re-render the server component so the new post appears in the list as
      // the server actually stored it, rather than a local guess at it.
      startTransition(() => router.refresh());
    } catch (err) {
      setError(err instanceof Error ? err.message : "That post could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="space-y-2">
        <Label htmlFor="club-post-content">Write to the club</Label>
        <textarea
          id="club-post-content"
          value={content}
          onChange={(event) => setContent(event.target.value)}
          rows={4}
          maxLength={maxLength * 2}
          placeholder="Something the club would want to know…"
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          aria-describedby="club-post-counter"
        />
        <p
          id="club-post-counter"
          className={`text-xs ${tooLong ? "text-destructive" : "text-muted-foreground"}`}
        >
          {trimmed.length} of {maxLength} characters
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
            disabled
            checked={false}
            readOnly
            aria-describedby="club-post-share-note"
          />
          Share with all clubs
        </label>
        <Button type="submit" disabled={!canPost}>
          {saving || pending ? "Posting…" : "Post"}
        </Button>
      </div>
      <p id="club-post-share-note" className="text-xs text-muted-foreground">
        Sharing beyond your own club is not available yet. For now every post
        stays inside this club.
      </p>
    </form>
  );
}
