// @vitest-environment jsdom

/**
 * Where a failure on the Xero panels sends the admin's attention (#4975).
 *
 * Every panel here both loads data by itself and offers buttons. The two
 * failures are different events: a load the panel ran itself (opening, a
 * filter, a background refresh) is a passive notice that must not pull focus
 * away from whatever the admin is doing, while ANY button the admin pressed
 * (Retry, Sync, Replay, Repair, a dry run, a scan, a Refresh) is the next thing
 * they have to act on, so its explanation takes focus — and takes it AGAIN when
 * a retry fails with the identical message, which a bare message-change effect
 * would miss.
 *
 * Every alert sits OUTSIDE its card, because the card body unmounts while the
 * section is collapsed: header buttons are pressed while collapsed, and an
 * alert inside the body would remount on re-opening and take focus for a stale
 * failure.
 */

import "@testing-library/jest-dom/vitest"
import { act, fireEvent, render, screen, waitFor } from "@/lib/__tests__/support/club-time-render"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { expectRecoveryAlertToHoldFocus } from "@/lib/__tests__/helpers/focus"
import { ErasedMemberContactsPanel } from "../erased-member-contacts-panel"
import { InboundEventsPanel } from "../inbound-events-panel"
import { MembershipSyncPanel } from "../membership-sync-panel"
import { MissingContactsPanel } from "../missing-contacts-panel"
import { OperationsPanel } from "../operations-panel"
import { SetupPanels } from "../setup-panels"
import type { XeroOperation } from "../types"

const mocks = vi.hoisted(() => ({
  fetchJson: vi.fn(),
  postJson: vi.fn(),
  loadGroups: vi.fn(),
}))

vi.mock("../api", () => ({
  fetchJson: mocks.fetchJson,
  postJson: mocks.postJson,
}))

vi.mock("@/lib/admin-xero-contact-groups", () => ({
  loadAdminXeroContactGroups: mocks.loadGroups,
}))

vi.mock("next/navigation", () => ({
  usePathname: () => "/admin/xero",
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}))

// PARTIAL: `view-only-action.tsx` reads its shared refusal copy from this module.
vi.mock("@/hooks/use-admin-area-edit-access", async (importOriginal) => {
  const actual =
    (await importOriginal()) as typeof import("@/hooks/use-admin-area-edit-access")
  return { ...actual, useAdminAreaEditAccess: () => true }
})

// The confirmation dialogs are not what is under test; answer yes.
vi.mock("@/components/confirm-dialog", () => ({
  useConfirm: () => ({
    confirm: vi.fn().mockResolvedValue(true),
    prompt: vi.fn().mockResolvedValue("reason"),
    confirmDialog: null,
  }),
}))

const originalScrollIntoView = HTMLElement.prototype.scrollIntoView

beforeEach(() => {
  mocks.fetchJson.mockReset()
  mocks.postJson.mockReset()
  mocks.loadGroups.mockReset()
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  })
})

afterEach(() => {
  if (originalScrollIntoView) {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: originalScrollIntoView,
    })
  } else {
    delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView
  }
})

function alertById(id: string) {
  const alert = document.getElementById(id)
  if (!alert) throw new Error(`no element #${id}`)
  return alert
}

/**
 * Press `button`, expect the failure to take focus; put focus back on the
 * button and press it again with the SAME failure, and expect focus to be taken
 * again rather than left on the re-enabled button.
 */
async function expectRepeatedFailureTakesFocus(alertId: string, button: () => HTMLElement, message: string) {
  const alert = alertById(alertId)
  fireEvent.click(button())
  await waitFor(() => expect(alert).toHaveTextContent(message))
  await expectRecoveryAlertToHoldFocus(alert)

  await waitFor(() => expect(button()).toBeEnabled())
  act(() => button().focus())
  expect(document.activeElement).toBe(button())

  fireEvent.click(button())
  await expectRecoveryAlertToHoldFocus(alert)
  expect(alert).toHaveTextContent(message)
}

/** A load failure shows its message and leaves focus where it was. */
async function expectPassiveLoadFailure(message: string, actionAlertId: string) {
  expect(await screen.findByText(message)).toBeInTheDocument()
  // Let every pending effect run before checking nothing moved.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  expect(document.activeElement).toBe(document.body)
  expect(alertById(actionAlertId)).toBeEmptyDOMElement()
}

describe("MembershipSyncPanel", () => {
  const props = {
    connected: true,
    onToggle: vi.fn(),
    syncing: null,
    setSyncing: vi.fn(),
    setSyncResult: vi.fn(),
    onRefreshDiagnostics: vi.fn(),
    refreshToken: 0,
  }

  it("leaves focus alone when the refresh state cannot be read", async () => {
    mocks.fetchJson.mockRejectedValue(new Error("Health read failed"))
    render(<MembershipSyncPanel {...props} open />)
    await expectPassiveLoadFailure("Health read failed", "xero-membership-sync-action-error")
  })

  it("focuses a failed sync every time, even with the card collapsed", async () => {
    mocks.postJson.mockRejectedValue(new Error("Xero refused the refresh"))
    render(<MembershipSyncPanel {...props} open={false} />)
    await expectRepeatedFailureTakesFocus(
      "xero-membership-sync-action-error",
      () => screen.getByRole("button", { name: "Run Incremental Refresh" }),
      "Xero refused the refresh",
    )
  })
})

function failedOperation(overrides: Partial<XeroOperation> = {}): XeroOperation {
  return {
    id: "op-1",
    direction: "OUTBOUND",
    entityType: "INVOICE",
    operationType: "CREATE",
    localModel: null,
    localId: null,
    localUrl: null,
    status: "FAILED",
    idempotencyKey: null,
    correlationKey: null,
    attemptCount: 1,
    replayable: false,
    lastErrorCode: null,
    lastErrorMessage: null,
    requestPayload: {},
    responsePayload: {},
    xeroObjectType: null,
    xeroObjectId: null,
    xeroObjectNumber: null,
    xeroObjectUrl: null,
    createdByMemberId: null,
    startedAt: null,
    completedAt: null,
    manuallyResolvedAt: null,
    manuallyResolvedReason: null,
    manuallyResolvedById: null,
    createdAt: "2026-06-30T00:00:00.000Z",
    updatedAt: "2026-06-30T00:00:00.000Z",
    supported: false,
    reason: null,
    failureState: "ACTIVE",
    failureStateReason: null,
    failureRootKey: null,
    staleRunning: false,
    resolveAsksCreditNoteNumber: false,
    resolveCreditNoteAmountCents: null,
    resolveRefusal: null,
    ...overrides,
  }
}

describe("OperationsPanel", () => {
  const props = {
    connected: true,
    onToggle: vi.fn(),
    onMessage: vi.fn(),
    onRefreshDiagnostics: vi.fn(),
    refreshToken: 0,
  }

  it("leaves focus alone when the operation history cannot be read", async () => {
    mocks.fetchJson.mockRejectedValue(new Error("History read failed"))
    render(<OperationsPanel {...props} open />)
    await expectPassiveLoadFailure("History read failed", "xero-operations-action-error")
  })

  it("focuses a failed Retry Active Failed every time, even with the card collapsed", async () => {
    mocks.postJson.mockRejectedValue(new Error("Queue is locked"))
    render(<OperationsPanel {...props} open={false} />)
    await expectRepeatedFailureTakesFocus(
      "xero-operations-action-error",
      () => screen.getByRole("button", { name: "Retry Active Failed" }),
      "Queue is locked",
    )
  })

  it("focuses a failed Refresh pressed while the card is collapsed", async () => {
    mocks.fetchJson.mockRejectedValue(new Error("History read failed"))
    render(<OperationsPanel {...props} open={false} />)
    await expectRepeatedFailureTakesFocus(
      "xero-operations-action-error",
      () => screen.getByRole("button", { name: "Refresh" }),
      "History read failed",
    )
  })

  it("clears a stale action failure when a pressed Refresh succeeds", async () => {
    mocks.postJson.mockRejectedValue(new Error("Queue is locked"))
    mocks.fetchJson.mockResolvedValue({ data: [], total: 0, hiddenFailedCount: 0 })
    render(<OperationsPanel {...props} open={false} />)
    const alert = alertById("xero-operations-action-error")
    fireEvent.click(screen.getByRole("button", { name: "Retry Active Failed" }))
    await waitFor(() => expect(alert).toHaveTextContent("Queue is locked"))
    await waitFor(() => expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled())
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }))
    await waitFor(() => expect(alert).toBeEmptyDOMElement())
  })

  it("focuses a Resolve the row says will be refused, every time", async () => {
    mocks.fetchJson.mockResolvedValue({
      data: [failedOperation({ resolveRefusal: "This refund needs a credit note first" })],
      total: 1,
      hiddenFailedCount: 0,
    })
    render(<OperationsPanel {...props} open />)
    const resolve = () => screen.getByRole("button", { name: "Resolve (fixed in Xero)" })
    await waitFor(() => expect(resolve()).toBeEnabled())
    await expectRepeatedFailureTakesFocus(
      "xero-operations-action-error",
      resolve,
      "This refund needs a credit note first",
    )
    expect(mocks.postJson).not.toHaveBeenCalled()
  })

  it("focuses a Resolve the route refuses, every time", async () => {
    mocks.fetchJson.mockResolvedValue({ data: [failedOperation()], total: 1, hiddenFailedCount: 0 })
    mocks.postJson.mockRejectedValue(new Error("Resolve refused"))
    render(<OperationsPanel {...props} open />)
    const resolve = () => screen.getByRole("button", { name: "Resolve (fixed in Xero)" })
    await waitFor(() => expect(resolve()).toBeEnabled())
    await expectRepeatedFailureTakesFocus("xero-operations-action-error", resolve, "Resolve refused")
  })
})

describe("InboundEventsPanel", () => {
  const props = {
    connected: true,
    open: true,
    onToggle: vi.fn(),
    onMessage: vi.fn(),
    onRefreshOperations: vi.fn(),
    onRefreshDiagnostics: vi.fn(),
    refreshToken: 0,
  }

  it("leaves focus alone when the events cannot be read", async () => {
    mocks.fetchJson.mockRejectedValue(new Error("Events read failed"))
    render(<InboundEventsPanel {...props} />)
    await expectPassiveLoadFailure("Events read failed", "xero-inbound-action-error")
  })

  it("focuses a failed replay every time", async () => {
    mocks.fetchJson.mockResolvedValue({
      data: [
        {
          id: "event-1",
          source: "WEBHOOK",
          eventCategory: "INVOICE",
          eventType: "UPDATE",
          resourceId: null,
          eventCreatedAt: null,
          correlationKey: "corr-1",
          payload: {},
          status: "FAILED",
          errorMessage: null,
          processedAt: null,
          createdAt: "2026-06-30T00:00:00.000Z",
          updatedAt: "2026-06-30T00:00:00.000Z",
          xeroObjectUrl: null,
          canReplay: true,
        },
      ],
      total: 1,
    })
    mocks.postJson.mockRejectedValue(new Error("Replay refused"))
    render(<InboundEventsPanel {...props} />)
    await screen.findByText("INVOICE UPDATE")
    const replayButton = () =>
      screen.getAllByRole("button").find((button) => button.closest(".rounded-md.border.p-3"))!
    await expectRepeatedFailureTakesFocus("xero-inbound-action-error", replayButton, "Replay refused")
  })

  it("focuses a failed Refresh pressed while the card is collapsed", async () => {
    mocks.fetchJson.mockRejectedValue(new Error("Events read failed"))
    render(<InboundEventsPanel {...props} open={false} />)
    await expectRepeatedFailureTakesFocus(
      "xero-inbound-action-error",
      () => screen.getByRole("button", { name: "Refresh" }),
      "Events read failed",
    )
  })
})

describe("ErasedMemberContactsPanel", () => {
  const props = { onToggle: vi.fn(), currentXeroPath: "/admin/xero", shortCode: null }

  it("leaves focus alone when the review cannot be read", async () => {
    mocks.fetchJson.mockRejectedValue(new Error("Review read failed"))
    render(<ErasedMemberContactsPanel {...props} open />)
    await expectPassiveLoadFailure("Review read failed", "erased-member-contacts-action-error")
  })

  it("focuses a failed Xero check every time, even with the card collapsed", async () => {
    mocks.fetchJson.mockResolvedValue({
      review: {
        needsReview: 1,
        alreadyRetiredInXero: 0,
        rows: [
          {
            memberId: "member-1",
            xeroContactId: "contact-1",
            erasure: "HARD_DELETED",
            erasedAt: "2026-04-05T00:00:00.000Z",
            contactStatus: "UNKNOWN",
            contactStatusCheckedAt: null,
          },
        ],
        truncated: false,
        lastContactStatusCheckAt: null,
        contactCacheLastRefreshedAt: null,
        contactCacheAgeHours: null,
        contactCacheStale: false,
      },
    })
    mocks.postJson.mockRejectedValue(new Error("Xero check failed"))
    const { rerender } = render(<ErasedMemberContactsPanel {...props} open />)
    const checkButton = () => screen.getByRole("button", { name: /check these in xero/i })
    await waitFor(() => expect(checkButton()).toBeEnabled())
    rerender(<ErasedMemberContactsPanel {...props} open={false} />)
    await expectRepeatedFailureTakesFocus("erased-member-contacts-action-error", checkButton, "Xero check failed")
  })

  it("focuses a failed Refresh pressed while the card is collapsed", async () => {
    mocks.fetchJson.mockRejectedValue(new Error("Review read failed"))
    render(<ErasedMemberContactsPanel {...props} open={false} />)
    await expectRepeatedFailureTakesFocus(
      "erased-member-contacts-action-error",
      () => screen.getByRole("button", { name: "Refresh" }),
      "Review read failed",
    )
  })
})

describe("MissingContactsPanel", () => {
  const props = {
    connected: true,
    open: true,
    onToggle: vi.fn(),
    currentXeroPath: "/admin/xero",
    shortCode: null,
    onMessage: vi.fn(),
    onRefreshOperations: vi.fn(),
  }

  it("focuses a failed dry run every time: a press the admin made is an outcome", async () => {
    mocks.fetchJson.mockRejectedValue(new Error("Dry run failed"))
    render(<MissingContactsPanel {...props} />)
    await expectRepeatedFailureTakesFocus(
      "xero-missing-contacts-action-error",
      () => screen.getByRole("button", { name: /run the dry run/i }),
      "Dry run failed",
    )
  })

  it("focuses a failed contact creation every time", async () => {
    mocks.fetchJson.mockResolvedValue({
      snapshot: {
        cacheReady: true,
        contactCacheLastRefreshedAt: "2026-06-01T00:00:00.000Z",
        contactCacheAgeHours: 2,
        contactCacheStale: false,
        plannedDigest: "digest",
        chunkSize: 15,
        estimatedXeroCallsPerChunk: 4,
        eligible: 1,
        alreadyLinked: 0,
        unlinked: 1,
        pushable: 1,
        excluded: 0,
        ambiguous: 0,
        pushableRows: [
          {
            memberId: "member-1",
            memberName: "Riley Chen",
            memberEmail: "riley@example.test",
            evidence: "NO_CACHED_MATCH",
            cachedXeroContactId: null,
          },
        ],
        excludedRows: [],
        ambiguousRows: [],
      },
      notReadyMessage: null,
    })
    mocks.postJson.mockRejectedValue(new Error("Plan moved underneath you"))
    render(<MissingContactsPanel {...props} />)
    fireEvent.click(screen.getByRole("button", { name: /run the dry run/i }))
    const createButton = () => screen.getByRole("button", { name: /create the next 1 of 1/i })
    await waitFor(() => expect(createButton()).toBeEnabled())
    await expectRepeatedFailureTakesFocus("xero-missing-contacts-action-error", createButton, "Plan moved underneath you")
  })
})

describe("SetupPanels", () => {
  const props = {
    connected: true,
    open: true,
    onToggle: vi.fn(),
    clubName: "Test Club",
    bookingsName: "Bookings",
    syncing: null,
    setSyncing: vi.fn(),
    setSyncResult: vi.fn(),
    onMessage: vi.fn(),
    onRefreshOperations: vi.fn(),
    onRefreshDiagnostics: vi.fn(),
  }

  beforeEach(() => {
    mocks.loadGroups.mockResolvedValue({ groups: [{ id: "group-1", name: "Adults", contactCount: 1 }] })
  })

  it("focuses a failed duplicate scan every time: a press the admin made is an outcome", async () => {
    mocks.fetchJson.mockRejectedValue(new Error("Scan failed"))
    render(<SetupPanels {...props} />)
    await screen.findByText("Adults")
    await expectRepeatedFailureTakesFocus(
      "xero-setup-action-error",
      () => screen.getByRole("button", { name: /scan for duplicates/i }),
      "Scan failed",
    )
  })

  it("focuses a failed Refresh Contact Groups from Xero, which rebuilds the cache", async () => {
    mocks.fetchJson.mockResolvedValue({ membershipTypes: [] })
    render(<SetupPanels {...props} />)
    await screen.findByText("Adults")
    mocks.loadGroups.mockRejectedValue(new Error("Xero groups unavailable"))
    await expectRepeatedFailureTakesFocus(
      "xero-setup-action-error",
      () => screen.getByRole("button", { name: /refresh contact groups from xero/i }),
      "Xero groups unavailable",
    )
  })

  it("leaves focus alone when the contact groups cannot be loaded on opening", async () => {
    mocks.fetchJson.mockResolvedValue({ membershipTypes: [] })
    // One failure is enough to see where it lands. The opening load is not
    // retried automatically (ALP-591), so the admin's Load press recovers it.
    mocks.loadGroups.mockReset()
    mocks.loadGroups
      .mockRejectedValueOnce(new Error("Groups read failed"))
      .mockResolvedValue({ groups: [{ id: "group-1", name: "Adults", contactCount: 1 }] })
    render(<SetupPanels {...props} />)
    await screen.findByText("Groups read failed")
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(document.activeElement).toBe(document.body)
    expect(alertById("xero-setup-action-error")).toBeEmptyDOMElement()
    fireEvent.click(screen.getByRole("button", { name: "Load Contact Groups" }))
    await screen.findByText("Adults")
    expect(screen.queryByText("Groups read failed")).toBeNull()
  })

  it("does not take focus for an old failure when the card is collapsed and re-opened", async () => {
    mocks.fetchJson.mockResolvedValue({ membershipTypes: [] })
    mocks.postJson.mockRejectedValue(new Error("Repair failed"))
    const { rerender } = render(<SetupPanels {...props} />)
    await screen.findByText("Adults")
    const alert = alertById("xero-setup-action-error")
    fireEvent.click(screen.getByRole("button", { name: "Repair Canonical Links" }))
    await waitFor(() => expect(alert).toHaveTextContent("Repair failed"))
    await expectRecoveryAlertToHoldFocus(alert)

    rerender(<SetupPanels {...props} open={false} />)
    const toggle = () => screen.getByRole("button", { name: /setup tools/i })
    act(() => toggle().focus())
    rerender(<SetupPanels {...props} open />)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(document.activeElement).toBe(toggle())
  })

  it("focuses a failed link repair every time", async () => {
    mocks.fetchJson.mockResolvedValue({ membershipTypes: [] })
    mocks.postJson.mockRejectedValue(new Error("Repair failed"))
    render(<SetupPanels {...props} />)
    await screen.findByText("Adults")
    await expectRepeatedFailureTakesFocus(
      "xero-setup-action-error",
      () => screen.getByRole("button", { name: "Repair Canonical Links" }),
      "Repair failed",
    )
  })
})
