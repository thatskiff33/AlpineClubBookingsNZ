"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import {
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import type { AdminClubPost, AdminPostTab } from "@/lib/club-posts-admin";
import { useClubTime } from "@/components/club-time-provider";

/**
 * Club message board moderation (#2998, epic #2992).
 *
 * A queue with per-row actions rather than a settings form, so it follows the
 * queue shape of the maintenance-report sign section: ONE
 * `AdminViewOnlySectionBanner` at the top of a frame that renders in every
 * state, and every action through `ViewOnlyActionButton` with
 * `describeReason={false}` so the view-only reason is stated once in the banner
 * rather than on disabled buttons that are out of the tab order.
 *
 * The tab and the search live in the URL, so switching either is an ordinary
 * navigation and there is no fetch-on-mount to get wrong.
 */
export function ClubPostsAdmin({
  posts,
  tab,
  query,
  pendingWithdrawals,
}: {
  posts: AdminClubPost[];
  tab: AdminPostTab;
  query: string;
  /** Removed posts whose network takedown is not yet confirmed (#3091 r1). */
  pendingWithdrawals: number;
}) {
  const club = useClubTime();

  const router = useRouter();
  const canEdit = useAdminAreaEditAccess("membership");
  const [pending, startTransition] = useTransition();
  const [search, setSearch] = useState(query);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  async function act(
    id: string,
    request: () => Promise<Response>,
    confirmText?: string,
  ) {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusyId(id);
    setError(null);
    try {
      const res = await request();
      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(payload?.error ?? "That change could not be saved.");
      }
      setEditingId(null);
      startTransition(() => router.refresh());
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "That change could not be saved.",
      );
    } finally {
      setBusyId(null);
    }
  }

  const patch = (id: string, body: Record<string, unknown>) =>
    fetch(`/api/admin/club-posts/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  const tabs: { key: AdminPostTab; label: string }[] = [
    { key: "all", label: "All posts" },
    { key: "hidden", label: "Hidden" },
  ];

  function href(next: AdminPostTab): string {
    const params = new URLSearchParams({ tab: next });
    if (query.trim()) params.set("q", query.trim());
    return `/admin/message-board?${params}`;
  }

  // THE FRAME. Banner and feedback region render in every state — including a
  // first load and a failed one — so the section is never mounted together with
  // an already-populated alert, which some screen readers drop silently.
  return (
    <div>
      <AdminViewOnlySectionBanner canEdit={canEdit} className="mb-4">
        You can read the message board but not hide, edit or remove posts. Ask an
        administrator with membership access.
      </AdminViewOnlySectionBanner>

      {error ? (
        <Alert variant="error" className="mb-4">
          {error}
        </Alert>
      ) : null}

      {pendingWithdrawals > 0 ? (
        // #3091 review 1: a removal the central server has not confirmed is
        // only removed LOCALLY — other clubs may still see it. Named here so
        // the admin who clicked Remove is not left believing it is gone
        // everywhere; the retry runs automatically each cron cycle.
        <Alert variant="warning" className="mb-4">
          {pendingWithdrawals === 1
            ? "1 removed post is still being taken down from the shared network — other clubs may see it until the central server confirms. Retrying automatically."
            : `${pendingWithdrawals} removed posts are still being taken down from the shared network — other clubs may see them until the central server confirms. Retrying automatically.`}
        </Alert>
      ) : null}

      <div className="mb-4 flex flex-wrap items-center gap-2">
        {tabs.map((entry) => (
          <Button
            key={entry.key}
            size="sm"
            asChild
            variant={entry.key === tab ? "default" : "outline"}
          >
            <Link href={href(entry.key)}>{entry.label}</Link>
          </Button>
        ))}
        <form
          className="ml-auto flex gap-2"
          action="/admin/message-board"
          method="get"
        >
          <input type="hidden" name="tab" value={tab} />
          <Input
            name="q"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search posts or authors"
            className="w-64"
          />
          <Button size="sm" variant="outline" type="submit">
            Search
          </Button>
        </form>
      </div>

      {posts.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-muted-foreground">
            {tab === "hidden"
              ? "Nothing is hidden."
              : "No posts on the board yet."}
          </CardContent>
        </Card>
      ) : (
        <ul className="space-y-3">
          {posts.map((post) => {
            const busy = busyId === post.id || pending;
            const isEditing = editingId === post.id;
            return (
              <li key={post.id}>
                <Card>
                  <CardContent className="space-y-3 pt-6">
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
                      <span className="font-medium text-foreground">
                        {post.authorName}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {club.instantDate(new Date(post.postedAt))}
                      </span>
                      {post.hiddenAt ? (
                        <span className="rounded-full bg-warning-3 px-2 py-0.5 text-xs font-medium text-warning-11">
                          Hidden from members
                        </span>
                      ) : null}
                    </div>

                    {isEditing ? (
                      <div className="space-y-2">
                        <textarea
                          value={draft}
                          onChange={(event) => setDraft(event.target.value)}
                          rows={5}
                          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                          aria-label="Post text"
                        />
                        <div className="flex gap-2">
                          <ViewOnlyActionButton
                            canEdit={canEdit}
                            describeReason={false}
                            size="sm"
                            disabled={busy || draft.trim().length === 0}
                            onClick={() =>
                              void act(post.id, () =>
                                patch(post.id, { content: draft }),
                              )
                            }
                          >
                            Save text
                          </ViewOnlyActionButton>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busy}
                            onClick={() => setEditingId(null)}
                          >
                            Cancel
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <p className="whitespace-pre-wrap text-sm text-foreground">
                        {post.content}
                      </p>
                    )}

                    {!isEditing ? (
                      <div className="flex flex-wrap gap-2">
                        <ViewOnlyActionButton
                          canEdit={canEdit}
                          describeReason={false}
                          variant="outline"
                          size="sm"
                          disabled={busy}
                          onClick={() =>
                            void act(post.id, () =>
                              patch(post.id, { hidden: !post.hiddenAt }),
                            )
                          }
                        >
                          {post.hiddenAt ? "Show to members" : "Hide"}
                        </ViewOnlyActionButton>

                        <ViewOnlyActionButton
                          canEdit={canEdit}
                          describeReason={false}
                          variant="outline"
                          size="sm"
                          disabled={busy}
                          onClick={() => {
                            setDraft(post.content);
                            setEditingId(post.id);
                          }}
                        >
                          Edit text
                        </ViewOnlyActionButton>

                        <ViewOnlyActionButton
                          canEdit={canEdit}
                          describeReason={false}
                          variant="outline"
                          size="sm"
                          className="ml-auto text-destructive"
                          disabled={busy}
                          onClick={() =>
                            void act(
                              post.id,
                              () =>
                                fetch(`/api/admin/club-posts/${post.id}`, {
                                  method: "DELETE",
                                }),
                              "Remove this post?\n\nThe text is deleted permanently and cannot be recovered. Hiding is reversible; this is not.",
                            )
                          }
                        >
                          Remove
                        </ViewOnlyActionButton>
                      </div>
                    ) : null}
                  </CardContent>
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
