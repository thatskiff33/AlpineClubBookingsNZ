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
import type {
  AdminClubPost,
  AdminPostTab,
  AdminShareProblemPost,
} from "@/lib/club-posts-admin";
import { ClubPostShareProblems } from "@/components/admin/club-posts/club-post-share-problems";
import { useClubTime } from "@/components/club-time-provider";
import { adminHref } from "@/lib/admin-hubs";

/** A recorded reason ends as a sentence, whatever the server's text did. */
function sentence(text: string): string {
  return /[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`;
}

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
 *
 * Above the list, the "Sharing problems" panel (#5246) names every post that
 * may be on other clubs' boards in a way this site did not record; each card
 * below carries a badge when its own share ended in an error.
 */
export function ClubPostsAdmin({
  posts,
  tab,
  query,
  shareProblems,
}: {
  posts: AdminClubPost[];
  tab: AdminPostTab;
  query: string;
  /** Posts that may have a copy on other clubs' boards (#3091 r1, #5246). */
  shareProblems: AdminShareProblemPost[];
}) {
  const club = useClubTime();

  const router = useRouter();
  const canEdit = useAdminAreaEditAccess("membership");
  const [pending, startTransition] = useTransition();
  const [search, setSearch] = useState(query);
  const [error, setError] = useState<string | null>(null);
  // A failed action from the sharing-problems panel, shown on its own entry.
  const [panelError, setPanelError] = useState<{
    postId: string;
    message: string;
  } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  async function act(
    id: string,
    request: () => Promise<Response>,
    confirmText?: string,
    { inline = false }: { inline?: boolean } = {},
  ) {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusyId(id);
    setError(null);
    setPanelError(null);
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
      const message =
        err instanceof Error ? err.message : "That change could not be saved.";
      if (inline) setPanelError({ postId: id, message });
      else setError(message);
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
    return `${adminHref("message-board")}?${params}`;
  }

  // THE FRAME. Banner and feedback region render in every state — including a
  // first load and a failed one — so the section is never mounted together with
  // an already-populated alert, which some screen readers drop silently.
  return (
    <div>
      <AdminViewOnlySectionBanner canEdit={canEdit} className="mb-4">
        You can read the message board but not hide, edit or remove posts, or
        withdraw shared copies. Ask an administrator with membership access.
      </AdminViewOnlySectionBanner>

      {error ? (
        <Alert variant="error" className="mb-4">
          {error}
        </Alert>
      ) : null}

      <ClubPostShareProblems
        posts={shareProblems}
        canEdit={canEdit}
        busyId={busyId}
        pending={pending}
        inlineError={panelError}
        ancestorRendersViewOnlyBanner
        onWithdraw={(id) =>
          void act(
            id,
            () => patch(id, { withdrawSharedCopy: true }),
            // A removed post is no longer on this board (#5246 review).
            shareProblems.find((post) => post.id === id)?.removedAt
              ? "Withdraw this removed post's copy from other clubs' boards?\n\nThe post is already removed from this club's board."
              : "Withdraw this post's copy from other clubs' boards?\n\nThe post stays on this club's board as it is.",
            { inline: true },
          )
        }
        onDismiss={(id) =>
          void act(
            id,
            () => patch(id, { dismissShareProblem: true }),
            "Mark this as dealt with?\n\nDo this once any copy on other clubs' boards has been taken down, or you have confirmed there is none.",
            { inline: true },
          )
        }
      />

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
          action={adminHref("message-board")}
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
                      {post.shareProblem?.kind === "share-failed" ? (
                        <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                          Not shared with other clubs
                        </span>
                      ) : post.shareProblem ? (
                        <span className="rounded-full bg-warning-3 px-2 py-0.5 text-xs font-medium text-warning-11">
                          Sharing problem
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

                    {post.shareProblem?.kind === "share-failed" ? (
                      <p className="text-xs text-muted-foreground">
                        Sharing failed and was not retried:{" "}
                        {sentence(post.shareProblem.shareError ?? "")} This
                        post is only on this club&apos;s board.
                      </p>
                    ) : null}

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
