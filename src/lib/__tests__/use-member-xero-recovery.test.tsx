// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  linkMemberXeroContact: vi.fn(),
  pushMemberToXero: vi.fn(),
  searchXeroContacts: vi.fn(),
  unlinkMemberXeroContact: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn() } }));
vi.mock("@/lib/admin-member-xero-actions", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@/lib/admin-member-xero-actions");
  return { ...actual, ...mocks };
});

import { useMemberXero } from "@/app/(admin)/admin/members/[id]/_hooks/use-member-xero";
import { AdminMemberXeroActionError } from "@/lib/admin-member-xero-actions";

describe("useMemberXero partial-success recovery", () => {
  const fetchMember = vi.fn().mockResolvedValue(undefined);
  const setLoading = vi.fn();
  const setXeroError = vi.fn();
  const onPartialSuccess = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMember.mockResolvedValue(undefined);
  });

  it("reloads and suppresses duplicate create after Xero already created and linked", async () => {
    mocks.pushMemberToXero.mockRejectedValue(
      new AdminMemberXeroActionError("Retry required.", {
        xeroContactCreated: true,
        xeroContactLinked: true,
        xeroContactId: "contact-new",
        subscriptionRefreshPending: true,
      }),
    );
    const { result } = renderHook(() =>
      useMemberXero({
        id: "member-1",
        fetchMember,
        setLoading,
        setXeroError,
        onPartialSuccess,
      }),
    );

    act(() => {
      result.current.openCreateXero();
      result.current.setXeroCreateEntranceFeeInvoice(true);
    });
    expect(result.current.xeroCreateOpen).toBe(true);
    await act(async () => result.current.handleXeroPush());

    expect(result.current.xeroCreateOpen).toBe(false);
    expect(fetchMember).not.toHaveBeenCalled();
    expect(onPartialSuccess).toHaveBeenCalledWith(
      expect.objectContaining({
        recovery: expect.objectContaining({ xeroContactCreated: true }),
      }),
    );
  });

  it("retains an ordinary failed create draft and does not claim the member changed", async () => {
    mocks.pushMemberToXero.mockRejectedValue(
      new AdminMemberXeroActionError(
        "The service could not be reached. Your selections are still here.",
      ),
    );
    const { result } = renderHook(() =>
      useMemberXero({
        id: "member-1",
        fetchMember,
        setLoading,
        setXeroError,
        onPartialSuccess,
      }),
    );

    act(() => {
      result.current.openCreateXero();
      result.current.setXeroCreateEntranceFeeInvoice(true);
      result.current.setXeroEntranceFeeNarration("Family joining fee");
    });
    await act(async () => result.current.handleXeroPush());

    expect(result.current.xeroCreateOpen).toBe(true);
    expect(result.current.xeroEntranceFeeNarration).toBe("Family joining fee");
    expect(fetchMember).not.toHaveBeenCalled();
    expect(onPartialSuccess).not.toHaveBeenCalled();
    expect(setXeroError).toHaveBeenLastCalledWith(
      "The service could not be reached. Your selections are still here.",
    );
  });

  it("reloads after a link response says the canonical link may have changed", async () => {
    mocks.linkMemberXeroContact.mockRejectedValue(
      new AdminMemberXeroActionError("Retry required.", {
        xeroLinkMayHaveChanged: true,
        xeroContactLinked: true,
        xeroContactId: "contact-existing",
        subscriptionRefreshPending: true,
      }),
    );
    const { result } = renderHook(() =>
      useMemberXero({
        id: "member-1",
        fetchMember,
        setLoading,
        setXeroError,
        onPartialSuccess,
      }),
    );

    act(() => result.current.openLinkXero());
    await act(async () => result.current.handleXeroLink("contact-existing"));

    expect(result.current.xeroSearchOpen).toBe(false);
    expect(fetchMember).not.toHaveBeenCalled();
    expect(onPartialSuccess).toHaveBeenCalledTimes(1);
  });

  it("suppresses duplicate create when only the provider-created fact is proven", async () => {
    mocks.pushMemberToXero.mockRejectedValue(
      new AdminMemberXeroActionError("Retry required.", {
        recoveryKind: "CONTACT_CREATED_LINK_UNCONFIRMED",
        xeroContactCreated: true,
        xeroContactId: "contact-provider-only",
        xeroPostProcessingPending: true,
      }),
    );
    const { result } = renderHook(() =>
      useMemberXero({
        id: "member-1",
        fetchMember,
        setLoading,
        setXeroError,
        onPartialSuccess,
      }),
    );

    act(() => {
      result.current.openCreateXero();
      result.current.setXeroCreateEntranceFeeInvoice(true);
    });
    await act(async () => result.current.handleXeroPush());

    expect(result.current.xeroCreateOpen).toBe(false);
    expect(onPartialSuccess).toHaveBeenCalledTimes(1);
  });

  it("suppresses a second unlink after the canonical unlink committed", async () => {
    mocks.unlinkMemberXeroContact.mockRejectedValue(
      new AdminMemberXeroActionError("Retry required.", {
        recoveryKind: "CONTACT_UNLINKED",
        xeroContactUnlinked: true,
        subscriptionCleanupPending: true,
        xeroPostProcessingPending: true,
      }),
    );
    const { result } = renderHook(() =>
      useMemberXero({
        id: "member-1",
        fetchMember,
        setLoading,
        setXeroError,
        onPartialSuccess,
      }),
    );

    await act(async () => result.current.handleXeroUnlink());

    expect(onPartialSuccess).toHaveBeenCalledTimes(1);
    expect(setXeroError).not.toHaveBeenLastCalledWith("Retry required.");
  });
});
