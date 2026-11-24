// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cleanup, fireEvent, render, screen, waitFor, within } from "@/lib/__tests__/support/club-time-render";
import type { AdminClubPost, AdminShareProblemPost } from "@/lib/club-posts-admin";

/**
 * #5246: the admin message board's "Sharing problems" panel and the badges on
 * each post card. Admin-only; the member board shows none of this.
 */

const mocks = vi.hoisted(() => ({
  canEdit: vi.fn<() => boolean | undefined>(() => true),
  refresh: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: mocks.refresh }) }));
vi.mock("@/hooks/use-admin-area-edit-access", () => ({
  useAdminAreaEditAccess: () => mocks.canEdit(),
  ADMIN_VIEW_ONLY_ACTION_REASON: "View-only reason",
}));

import { ClubPostsAdmin } from "@/components/admin/club-posts/club-posts-admin";

function adminPost(overrides: Partial<AdminClubPost> = {}): AdminClubPost {
  return {
    id: "post-1",
    authorName: "Jo Whitcombe",
    authorMemberId: "member-1",
    content: "Chains needed above the second cattle stop.",
    postedAt: "2026-06-14T00:00:00.000Z",
    hiddenAt: null,
    removedAt: null,
    originClubName: null,
    shareProblem: null,
    ...overrides,
  };
}

const notRecorded = adminPost({
  shareProblem: { kind: "copy-not-recorded", shareError: "recording failed", serverPostId: "cmh3k9x2p0007qz1a" },
}) as AdminShareProblemPost;
const unknown = adminPost({
  id: "cmgz71lqe00010814",
  authorName: "Ana Ferreira",
  content: "Working bee moved to Saturday.",
  shareProblem: { kind: "outcome-unknown", shareError: null, serverPostId: null },
}) as AdminShareProblemPost;

const fetchMock = vi.fn();

function show(shareProblems: AdminShareProblemPost[], posts: AdminClubPost[] = []) {
  render(<ClubPostsAdmin posts={posts} tab="all" query="" shareProblems={shareProblems} />);
}
const panel = () => within(screen.getByRole("region", { name: /Sharing problems/ }));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.canEdit.mockReturnValue(true);
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ status: "withdrawn" })));
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(window, "confirm").mockReturnValue(true);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the sharing problems panel", () => {
  it("is absent when nothing is wrong", () => {
    show([]);
    expect(screen.queryByRole("region", { name: /Sharing problems/ })).toBeNull();
  });

  it("says in plain words what happened, shows the id with Copy and who to send it to", () => {
    show([notRecorded, unknown]);

    expect(screen.getByRole("heading", { name: "Sharing problems (2)" })).toBeInTheDocument();
    expect(panel().getByText("Copy on other clubs' boards")).toBeInTheDocument();
    expect(panel().getByText(/accepted this post, but this site could not record that.*It was not sent twice/)).toBeInTheDocument();
    expect(panel().getByLabelText("Central server id")).toHaveTextContent("cmh3k9x2p0007qz1a");
    expect(panel().getAllByRole("button", { name: /Copy/ })).toHaveLength(2);
    expect(panel().getByText(/send this id to the central server's administrator/)).toBeInTheDocument();

    // No id held: who to contact, the post reference, and dismissal instead of withdrawal.
    expect(panel().getByText("Share result unknown")).toBeInTheDocument();
    expect(panel().getByText(/holds no central server id.*central server's administrator/)).toBeInTheDocument();
    expect(panel().getByLabelText("Post reference")).toHaveTextContent("cmgz71lqe00010814");
    expect(panel().getAllByRole("button", { name: "Withdraw the shared copy" })).toHaveLength(1);
    expect(panel().getByRole("button", { name: "Mark as dealt with" })).toBeInTheDocument();
  });

  it("sends the withdrawal for that post, and refreshes", async () => {
    show([notRecorded]);

    fireEvent.click(panel().getByRole("button", { name: "Withdraw the shared copy" }));

    await waitFor(() => expect(mocks.refresh).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith("/api/admin/club-posts/post-1", expect.objectContaining({
      method: "PATCH",
      body: JSON.stringify({ withdrawSharedCopy: true }),
    }));
  });

  it("words the confirmation by whether the post is still on this board", async () => {
    const removed = adminPost({
      id: "post-9",
      removedAt: "2026-06-30T00:00:00.000Z",
      shareProblem: { kind: "withdrawal-pending", shareError: null, serverPostId: "cmh3k9x2p0009qz1a" },
    }) as AdminShareProblemPost;
    show([notRecorded, removed]);
    const confirm = vi.mocked(window.confirm);

    const [liveButton, removedButton] = panel().getAllByRole("button", { name: "Withdraw the shared copy" });
    fireEvent.click(liveButton!);
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(confirm.mock.calls[0]![0]).toMatch(/stays on this club's board/);
    // The first withdrawal disables the panel while it runs; let it settle so
    // the second click is not dropped by a disabled button.
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(removedButton).toBeEnabled());

    fireEvent.click(removedButton!);
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(2));
    expect(confirm.mock.calls[1]![0]).toMatch(/already removed from this club's board/);
    expect(confirm.mock.calls[1]![0]).not.toMatch(/stays on this club's board/);
  });

  it("shows a failed withdrawal on its own entry", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: "The central server did not confirm the withdrawal." }), { status: 502 }));
    show([notRecorded]);

    fireEvent.click(panel().getByRole("button", { name: "Withdraw the shared copy" }));

    expect(await panel().findByRole("alert")).toHaveTextContent("The central server did not confirm the withdrawal.");
  });

  it("sends the dismissal for a post with no id", async () => {
    show([unknown]);

    fireEvent.click(panel().getByRole("button", { name: "Mark as dealt with" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/admin/club-posts/cmgz71lqe00010814", expect.objectContaining({
      body: JSON.stringify({ dismissShareProblem: true }),
    })));
  });

  it("disables both actions for a view-only admin", () => {
    mocks.canEdit.mockReturnValue(false);
    show([notRecorded, unknown]);

    expect(panel().getByRole("button", { name: "Withdraw the shared copy" })).toBeDisabled();
    expect(panel().getByRole("button", { name: "Mark as dealt with" })).toBeDisabled();
  });
});

describe("the badges on post cards", () => {
  it("marks a stray copy as a sharing problem, and a failed share with its recorded reason", () => {
    show([], [
      notRecorded,
      adminPost({
        id: "post-2",
        authorName: "Piri Hohaia",
        shareProblem: { kind: "share-failed", shareError: "Gave up after 8 attempts: unreachable", serverPostId: null },
      }),
      adminPost({ id: "post-3", authorName: "Sam Te Rangi" }),
    ]);

    const cards = screen.getAllByRole("listitem");
    expect(within(cards[0]!).getByText("Sharing problem")).toBeInTheDocument();
    expect(within(cards[1]!).getByText("Not shared with other clubs")).toBeInTheDocument();
    expect(within(cards[1]!).getByText(/not retried: Gave up after 8 attempts: unreachable\. This post is only on this club's board/)).toBeInTheDocument();
    expect(within(cards[2]!).queryByText(/Sharing problem|Not shared/)).toBeNull();
  });
});
