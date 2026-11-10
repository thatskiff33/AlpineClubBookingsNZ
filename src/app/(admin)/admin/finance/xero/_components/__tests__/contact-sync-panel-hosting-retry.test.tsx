// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { ContactSyncPanel } from "../contact-sync-panel"
import { XERO_ACTION_NETWORK_ERROR } from "../api"
import { expectRecoveryAlertToHoldFocus } from "@/lib/__tests__/helpers/focus"

vi.mock("@/components/ui/select", () => ({
  Select: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectValue: () => <span />,
}))

const retryMessage =
  "The database update could not be completed because this booking or member changed. Reload before trying again. If a payment was involved, check its status before retrying."

describe("ContactSyncPanel participant retry recovery (#2597)", () => {
  const originalScrollIntoView = HTMLElement.prototype.scrollIntoView
  let scrollIntoView: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.clearAllMocks()
    scrollIntoView = vi.fn()
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    })
    global.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.startsWith("/api/admin/members?")) {
        return { ok: true, json: async () => ({ members: [] }) } as Response
      }
      if (url.startsWith("/api/admin/xero/search-contacts?")) {
        return {
          ok: true,
          json: async () => ({
            contacts: [
              {
                contactId: "xero-1",
                name: "Riley Chen",
                firstName: "Riley",
                lastName: "Chen",
                email: "riley@example.org",
                canImportAsMember: true,
              },
            ],
          }),
        } as Response
      }
      if (url === "/api/admin/xero/import-member-contact") {
        return {
          ok: false,
          status: 409,
          json: async () => ({
            error: retryMessage,
            code: "HOSTING_COVERAGE_PARTICIPANT_RETRY",
            recoveryKind: "MEMBER_IMPORTED_AND_LINKED",
            memberImported: true,
            memberId: "member/off-page",
            xeroContactId: "xero-1",
            xeroContactLinked: true,
            subscriptionRefreshPending: true,
            xeroPostProcessingPending: true,
          }),
        } as Response
      }
      throw new Error(`Unexpected request: ${url}`)
    }) as typeof fetch
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

  it("keeps a permanent alert, records the imported member, and focuses the recovery", async () => {
    const onRefreshDiagnostics = vi.fn()
    render(
      <ContactSyncPanel
        connected
        currentXeroPath="/admin/xero?section=contactSync&view=failed"
        open
        onToggle={vi.fn()}
        clubName="Test Club"
        syncing={null}
        setSyncing={vi.fn()}
        setSyncResult={vi.fn()}
        onMessage={vi.fn()}
        onRefreshOperations={vi.fn()}
        onRefreshDiagnostics={onRefreshDiagnostics}
      />,
    )

    const alert = document.getElementById("xero-contact-sync-recovery-error")
    const routineAlert = document.getElementById("xero-contact-sync-error")
    expect(alert).toHaveAttribute("role", "alert")
    expect(alert).toBeEmptyDOMElement()
    expect(alert).toHaveClass("sr-only")
    expect(routineAlert).toHaveAttribute("role", "alert")
    expect(routineAlert).toBeEmptyDOMElement()

    fireEvent.change(
      screen.getByPlaceholderText(/Search local members and Xero contacts/i),
      { target: { value: "Riley" } },
    )
    // Explicit headroom, not a style choice: the member search behind this button
    // is debounced by 250ms in contact-sync-panel.tsx before its fetch even
    // starts, and React Testing Library's default `findBy*` timeout is 1000ms. The
    // 750ms that leaves is enough on an idle machine and not always enough on a
    // loaded CI runner — this wait timed out once during the #2635 repeated-run
    // proof, on a line identical to `main`. It is setup, not the contract under
    // test, so waiting longer weakens nothing.
    fireEvent.click(
      await screen.findByRole("button", { name: "Import" }, { timeout: 5000 }),
    )

    await waitFor(() =>
      expect(alert).toHaveTextContent(/member was imported and linked to Xero/i),
    )
    expect(alert).toHaveTextContent(/member was imported and linked to Xero/i)
    expect(alert).toHaveTextContent(/Do not import this contact again/i)
    await expectRecoveryAlertToHoldFocus(alert)
    expect(scrollIntoView).toHaveBeenCalledWith({
      behavior: "smooth",
      block: "center",
    })
    expect(screen.getByText(/Member ID: member\/off-page - already linked to Xero/i)).toBeInTheDocument()
    const recoveryAction = screen.getByRole("link", {
      name: "Open affected member: Riley Chen",
    })
    expect(alert).toContainElement(recoveryAction)
    expect(recoveryAction).toHaveAttribute(
      "href",
      "/admin/members/member%2Foff-page?returnTo=%2Fadmin%2Fxero%3Fsection%3DcontactSync%26view%3Dfailed",
    )
    expect(onRefreshDiagnostics).toHaveBeenCalledTimes(1)
    expect(recoveryAction).toBeInTheDocument()

    const syncContacts = screen.getByRole("button", {
      name: /Sync Contacts from Xero/i,
    })
    const forceSync = screen.getByRole("button", { name: "Run Force Sync" })
    const changeTarget = screen.getByRole("button", { name: "Change" })
    expect(syncContacts).toBeDisabled()
    expect(forceSync).toBeDisabled()
    expect(changeTarget).toBeDisabled()

    fireEvent.click(syncContacts)
    fireEvent.click(forceSync)
    fireEvent.click(changeTarget)

    expect(global.fetch).toHaveBeenCalledTimes(3)
    expect(alert).toHaveTextContent(/Do not import this contact again/i)
    expect(routineAlert).toBeEmptyDOMElement()
    await expectRecoveryAlertToHoldFocus(alert)
    expect(recoveryAction).toBeInTheDocument()
  })

  it("shows and focuses a network error even when the panel starts collapsed", async () => {
    render(
      <ContactSyncPanel
        connected
        currentXeroPath="/admin/xero"
        open={false}
        onToggle={vi.fn()}
        clubName="Test Club"
        syncing={null}
        setSyncing={vi.fn()}
        setSyncResult={vi.fn()}
        onMessage={vi.fn()}
        onRefreshOperations={vi.fn()}
        onRefreshDiagnostics={vi.fn()}
      />,
    )

    const alert = document.getElementById("xero-contact-sync-error")
    const recoveryAlert = document.getElementById(
      "xero-contact-sync-recovery-error",
    )
    expect(alert).toHaveAttribute("role", "alert")
    expect(alert).toBeEmptyDOMElement()
    expect(recoveryAlert).toHaveAttribute("role", "alert")
    expect(recoveryAlert).toBeEmptyDOMElement()
    fireEvent.click(screen.getByRole("button", { name: /Sync Contacts from Xero/i }))

    await waitFor(() => expect(alert).toHaveTextContent(XERO_ACTION_NETWORK_ERROR))
    await expectRecoveryAlertToHoldFocus(alert)
    expect(scrollIntoView).toHaveBeenCalledWith({
      behavior: "smooth",
      block: "center",
    })
  })
})
