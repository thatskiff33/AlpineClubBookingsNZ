// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ClubTimeProvider } from "@/components/club-time-provider";
import { MemberLifecycleCard } from "../member-lifecycle-card";
import type { MemberDetail, MemberLifecycleActionRequest } from "../../_types";

// #5540: the Unarchive Member control shows only to a Full Admin looking at an
// archived member, takes a required reason, and the Archive history lists
// every archive decision and every unarchive, newest first.

const admin = (id: string, name: string) => ({ id, name, email: `${id}@example.com` });

function request(overrides: Partial<MemberLifecycleActionRequest>): MemberLifecycleActionRequest {
  return {
    id: "req",
    memberId: "m-1",
    action: "ARCHIVE",
    status: "APPROVED",
    reason: "",
    reviewNote: null,
    requestedAt: "2026-01-01T00:00:00.000Z",
    reviewedAt: null,
    processedAt: null,
    requestedBy: null,
    reviewedBy: null,
    ...overrides,
  };
}

// Two archive/unarchive cycles, then a rejected request, then the live archive.
const TWO_CYCLES: MemberLifecycleActionRequest[] = [
  request({ id: "a1", reason: "First archive", requestedAt: "2026-01-01T00:00:00.000Z", reviewedAt: "2026-01-02T00:00:00.000Z", requestedBy: admin("r1", "Rita Requester"), reviewedBy: admin("v1", "Vic Reviewer"), reviewNote: "Agreed" }),
  request({ id: "u1", action: "UNARCHIVE", reason: "First unarchive", requestedAt: "2026-02-01T00:00:00.000Z", reviewedAt: "2026-02-01T00:00:00.000Z", processedAt: "2026-02-01T00:00:00.000Z", requestedBy: admin("f1", "Fay Full"), reviewedBy: admin("f1", "Fay Full") }),
  request({ id: "x1", status: "REJECTED", reason: "Rejected archive", requestedAt: "2026-03-01T00:00:00.000Z", reviewedAt: "2026-03-02T00:00:00.000Z", requestedBy: admin("r1", "Rita Requester"), reviewedBy: admin("v1", "Vic Reviewer") }),
  request({ id: "a2", reason: "Second archive", requestedAt: "2026-04-01T00:00:00.000Z", reviewedAt: "2026-04-02T00:00:00.000Z", requestedBy: admin("r1", "Rita Requester"), reviewedBy: admin("v2", "Val Reviewer") }),
  request({ id: "u2", action: "UNARCHIVE", reason: "Second unarchive", requestedAt: "2026-05-01T00:00:00.000Z", reviewedAt: "2026-05-01T00:00:00.000Z", processedAt: "2026-05-01T00:00:00.000Z", requestedBy: admin("f2", "Finn Full"), reviewedBy: admin("f2", "Finn Full") }),
  request({ id: "a3", reason: "Third archive", requestedAt: "2026-06-01T00:00:00.000Z", reviewedAt: "2026-06-02T00:00:00.000Z", requestedBy: admin("r1", "Rita Requester"), reviewedBy: admin("v1", "Vic Reviewer") }),
  // A delete request on the same member is not archive history.
  request({ id: "d1", action: "DELETE", status: "REJECTED", reason: "Delete reason", reviewedAt: "2026-06-03T00:00:00.000Z" }),
];

const archivedMember = {
  id: "m-1",
  email: "pat@example.com",
  cancelledAt: "2026-01-01T00:00:00.000Z",
  cancelledReason: "Moved away",
  archivedAt: "2026-06-02T00:00:00.000Z",
  archivedReason: "Third archive",
} as unknown as MemberDetail;

function renderCard(overrides: Partial<ComponentProps<typeof MemberLifecycleCard>> = {}) {
  const submit = vi.fn(async () => true);
  const props: ComponentProps<typeof MemberLifecycleCard> = {
    member: archivedMember,
    pendingArchiveRequest: null,
    lifecycleRequests: TWO_CYCLES,
    canUnarchive: true,
    unarchive: { submitting: false, error: "", clearError: vi.fn(), submit },
    isArchiveRequester: false,
    canRequestArchive: false,
    canRequestCancellation: false,
    openCancellationRequest: null,
    archiveError: "",
    archiveReason: "",
    archiveReviewNotes: {},
    archiveActionLoading: null,
    cancellationError: "",
    cancellationReason: "",
    cancellationSubmitting: false,
    onChangeArchiveReason: vi.fn(),
    onChangeArchiveReviewNote: vi.fn(),
    onChangeCancellationReason: vi.fn(),
    onSubmitArchive: vi.fn(),
    onSubmitCancellation: vi.fn(),
    onReviewArchive: vi.fn(),
    canEdit: true,
    ...overrides,
  };
  render(
    <ClubTimeProvider zone="Pacific/Auckland" locale="en-NZ">
      <MemberLifecycleCard {...props} />
    </ClubTimeProvider>,
  );
  return { submit: props.unarchive.submit as typeof submit };
}

afterEach(cleanup);

describe("MemberLifecycleCard unarchive (#5540)", () => {
  it("shows Unarchive Member to a Full Admin on an archived member", () => {
    renderCard();
    expect(screen.getByRole("button", { name: /unarchive member/i })).toBeEnabled();
  });

  it("hides it when the viewer may not unarchive (not a Full Admin, or not archived)", () => {
    renderCard({ canUnarchive: false });
    expect(screen.queryByRole("button", { name: /unarchive member/i })).not.toBeInTheDocument();
  });

  it("disables it for a view-only admin", () => {
    renderCard({ canEdit: false });
    expect(screen.getByRole("button", { name: /unarchive member/i })).toBeDisabled();
  });

  it("asks for a reason, says what it will not undo, and submits the trimmed reason", async () => {
    const { submit } = renderCard();
    fireEvent.click(screen.getByRole("button", { name: /unarchive member/i }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/stays cancelled and inactive/i)).toBeInTheDocument();
    const confirm = within(dialog).getByRole("button", { name: /^unarchive member$/i });
    expect(confirm).toBeDisabled();

    fireEvent.change(within(dialog).getByLabelText(/reason/i), { target: { value: "  Archived by mistake  " } });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);

    await waitFor(() => expect(submit).toHaveBeenCalledWith("Archived by mistake"));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("keeps the dialog open and shows the server's refusal", async () => {
    renderCard({
      unarchive: { submitting: false, error: "This member is not archived.", clearError: vi.fn(), submit: vi.fn(async () => false) },
    });
    fireEvent.click(screen.getByRole("button", { name: /unarchive member/i }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("This member is not archived.")).toBeInTheDocument();
  });
});

describe("Archive history (#5540)", () => {
  it("lists every archive decision and unarchive across two cycles, newest first, without delete requests", () => {
    renderCard();
    const history = screen.getByRole("list", { name: "Archive history" });
    const items = within(history).getAllByRole("listitem");
    expect(items.map((item) => within(item).getByText(/^Reason:/).textContent)).toEqual([
      "Reason: Third archive",
      "Reason: Second unarchive",
      "Reason: Second archive",
      "Reason: Rejected archive",
      "Reason: First unarchive",
      "Reason: First archive",
    ]);
  });

  it("names who requested and approved an archive, who unarchived, and the review note", () => {
    renderCard();
    const items = within(screen.getByRole("list", { name: "Archive history" })).getAllByRole("listitem");
    const [thirdArchive, secondUnarchive, , rejected, , firstArchive] = items;

    expect(within(thirdArchive!).getByText("Archived")).toBeInTheDocument();
    expect(within(thirdArchive!).getByText(/^Approved by Vic Reviewer on /)).toBeInTheDocument();
    expect(within(thirdArchive!).getByText(/^Requested by Rita Requester on /)).toBeInTheDocument();

    expect(within(secondUnarchive!).getByText("Unarchived")).toBeInTheDocument();
    expect(within(secondUnarchive!).getByText(/^By Finn Full on /)).toBeInTheDocument();
    expect(within(secondUnarchive!).queryByText(/^Requested by/)).not.toBeInTheDocument();

    expect(within(rejected!).getByText("Archive rejected")).toBeInTheDocument();
    expect(within(rejected!).getByText(/^Rejected by Vic Reviewer on /)).toBeInTheDocument();

    expect(within(firstArchive!).getByText("Review note: Agreed")).toBeInTheDocument();
  });

  it("leaves a pending archive request out of the history", () => {
    renderCard({
      lifecycleRequests: [request({ id: "p1", status: "REQUESTED", reason: "Pending archive" })],
    });
    expect(screen.queryByRole("list", { name: "Archive history" })).not.toBeInTheDocument();
  });
});
