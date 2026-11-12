// @vitest-environment jsdom

/**
 * Where a failure on the Xero panels sends the admin's attention (#4975).
 *
 * Every panel here both reads data in the background and offers actions that
 * write. The two failures are different events: a read that failed is a passive
 * notice that must not pull focus away from whatever the admin is doing, while
 * a Retry, Sync, Replay or Repair that failed is the next thing they have to act
 * on, so its explanation takes focus — and takes it AGAIN when a retry fails
 * with the identical message, which a bare message-change effect would miss.
 *
 * The panels whose action buttons sit in the card header (Operations,
 * Membership sync, Erased members) are also pressed while COLLAPSED: the card
 * body is unmounted then, so a failure rendered inside it would have nowhere to
 * appear.
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

  it("leaves focus on the dry-run button when the read-only dry run fails", async () => {
    mocks.fetchJson.mockRejectedValue(new Error("Dry run failed"))
    render(<MissingContactsPanel {...props} />)
    const dryRun = screen.getByRole("button", { name: /run the dry run/i })
    act(() => dryRun.focus())
    fireEvent.click(dryRun)
    expect(await screen.findByText("Dry run failed")).toBeInTheDocument()
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /run the dry run/i }))
    expect(alertById("xero-missing-contacts-action-error")).toBeEmptyDOMElement()
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

  it("leaves focus on the scan button when the read-only duplicate scan fails", async () => {
    mocks.fetchJson.mockRejectedValue(new Error("Scan failed"))
    render(<SetupPanels {...props} />)
    await screen.findByText("Adults")
    const scan = () => screen.getByRole("button", { name: /scan for duplicates/i })
    act(() => scan().focus())
    fireEvent.click(scan())
    expect(await screen.findByText("Scan failed")).toBeInTheDocument()
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(document.activeElement).toBe(scan())
    expect(alertById("xero-setup-action-error")).toBeEmptyDOMElement()
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
