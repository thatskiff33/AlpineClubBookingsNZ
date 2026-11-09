// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest"
import { act, fireEvent, render, screen, waitFor, within } from "@/lib/__tests__/support/club-time-render"
import type { AnchorHTMLAttributes, ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { HealthAndDiagnosticsPanels } from "../health-diagnostics-panel"
import { expectRecoveryAlertToHoldFocus } from "@/lib/__tests__/helpers/focus"

vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    ...props
  }: { children: ReactNode; href: string } & AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={href} {...props}>{children}</a>
  ),
}))

const mismatchResponse = {
  cacheReady: true,
  lastRefreshedAt: "2026-08-07T00:00:00.000Z",
  count: 1,
  mismatches: [
    {
      memberId: "member-1",
      memberName: "Riley Chen",
      memberEmail: "riley@example.test",
      active: true,
      xeroContactId: "xero-contact-wrong",
      xeroContactName: "Different Person",
      xeroContactEmail: "different@example.test",
      reasons: ["Name does not match"],
    },
  ],
}

const healthResponse = {
  unlinkedMembers: { count: 0, href: "/admin/members" },
  failedOperations: { count: 0, legacyCount: 0 },
  pendingOperations: { count: 0 },
  lastMembershipRefresh: {
    at: null,
    lastCronStatus: null,
    lastCronStartedAt: null,
  },
  missingInvoices: { count: 0 },
  contactGroupMismatches: { count: 0, cacheReady: true },
  contactLinkMismatches: { count: 0, cacheReady: true },
  apiBudget: {
    status: "healthy",
    usagePercent: 0,
    totalCalls: 0,
    failedCalls: 0,
  },
}

describe("Xero health diagnostics partial unlink recovery (#2597)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    })
  })

  it("removes the proven unlink from the retry surface and keeps focused recovery through refresh", async () => {
    let linkReads = 0
    let manualRefreshes = 0
    let resolveHealth: ((response: Response) => void) | undefined
    let resolveLinks: ((response: Response) => void) | undefined

    global.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (
        url === "/api/admin/xero/contact-link-mismatches?limit=200" &&
        !init?.method
      ) {
        linkReads += 1
        if (linkReads === 1) {
          return Promise.resolve(
            new Response(JSON.stringify(mismatchResponse), { status: 200 }),
          )
        }
        if (linkReads === 2) {
          return new Promise<Response>((resolve) => {
            resolveLinks = resolve
          })
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({ ...mismatchResponse, count: 0, mismatches: [] }),
            { status: 200 },
          ),
        )
      }
      if (
        url === "/api/admin/xero/contact-link-mismatches" &&
        init?.method === "POST"
      ) {
        manualRefreshes += 1
        return Promise.resolve(
          new Response(
            JSON.stringify({ ...mismatchResponse, count: 0, mismatches: [] }),
            { status: 200 },
          ),
        )
      }
      if (
        url === "/api/admin/members/member-1/xero-unlink" &&
        init?.method === "POST"
      ) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              code: "XERO_PARTIAL_SUCCESS",
              error: "private cleanup detail",
              recoveryKind: "CONTACT_UNLINKED",
              xeroContactUnlinked: true,
              xeroLinkMayHaveChanged: true,
              subscriptionCleanupPending: true,
              xeroPostProcessingPending: true,
            }),
            { status: 409 },
          ),
        )
      }
      if (url === "/api/admin/xero/health") {
        return new Promise<Response>((resolve) => {
          resolveHealth = resolve
        })
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`))
    }) as typeof fetch

    const { rerender } = render(
      <HealthAndDiagnosticsPanels
        connected
        shortCode={null}
        currentXeroPath="/admin/xero"
        healthOpen={false}
        contactGroupMismatchesOpen={false}
        contactLinkMismatchesOpen
        onToggle={vi.fn()}
        onMessage={vi.fn()}
        onRefreshOperations={vi.fn()}
        refreshToken={0}
        scrollToSection={vi.fn()}
      />,
    )

    fireEvent.click(await screen.findByRole("button", { name: "Unlink" }))

    const alert = document.getElementById("xero-contact-link-recovery")
    await waitFor(() => expect(alert).toHaveTextContent(/Refreshing Xero diagnostics now/i))
    expect(alert).toHaveTextContent(/link was removed/i)
    expect(alert).not.toHaveTextContent("private cleanup detail")
    await expectRecoveryAlertToHoldFocus(alert)
    expect(screen.queryByRole("button", { name: "Unlink" })).not.toBeInTheDocument()
    const recoveryAction = screen.getByRole("link", {
      name: "Open affected member: Riley Chen",
    })
    expect(alert).toContainElement(recoveryAction)
    expect(recoveryAction).toHaveAttribute(
      "href",
      "/admin/members/member-1?returnTo=%2Fadmin%2Fxero",
    )

    await act(async () => {
      resolveHealth?.(new Response(JSON.stringify(healthResponse), { status: 200 }))
      resolveLinks?.(
        new Response(
          JSON.stringify({
            ...mismatchResponse,
            count: 0,
            mismatches: [],
          }),
          { status: 200 },
        ),
      )
    })

    await waitFor(() => expect(alert).toHaveTextContent(/Diagnostics were refreshed/i))
    expect(alert).toBe(document.getElementById("xero-contact-link-recovery"))
    expect(screen.queryByRole("button", { name: "Unlink" })).not.toBeInTheDocument()
    expect(recoveryAction).toBeInTheDocument()
    expect(recoveryAction).toHaveAttribute(
      "href",
      "/admin/members/member-1?returnTo=%2Fadmin%2Fxero",
    )

    rerender(
      <HealthAndDiagnosticsPanels
        connected
        shortCode={null}
        currentXeroPath="/admin/xero"
        healthOpen={false}
        contactGroupMismatchesOpen={false}
        contactLinkMismatchesOpen
        onToggle={vi.fn()}
        onMessage={vi.fn()}
        onRefreshOperations={vi.fn()}
        refreshToken={1}
        scrollToSection={vi.fn()}
      />,
    )
    await waitFor(() => expect(linkReads).toBe(3))
    expect(alert).toHaveTextContent(/link was removed/i)
    expect(recoveryAction).toBeInTheDocument()

    const manualRefresh = within(
      document.getElementById("xero-section-contactLinkMismatches")!,
    ).getByRole("button", { name: "Refresh" }) as HTMLButtonElement
    await waitFor(() => expect(manualRefresh.disabled).toBe(false))
    fireEvent.click(manualRefresh)
    await waitFor(() => expect(manualRefreshes).toBe(1))
    expect(alert).toHaveTextContent(/link was removed/i)
    expect(recoveryAction).toBeInTheDocument()
  })

  it("keeps the focused member recovery action when diagnostics refresh fails", async () => {
    let linkReads = 0
    let manualRefreshes = 0

    global.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (
        url === "/api/admin/xero/contact-link-mismatches?limit=200" &&
        !init?.method
      ) {
        linkReads += 1
        if (linkReads === 1) {
          return Promise.resolve(
            new Response(JSON.stringify(mismatchResponse), { status: 200 }),
          )
        }
        return Promise.reject(new Error("diagnostics unavailable"))
      }
      if (
        url === "/api/admin/xero/contact-link-mismatches" &&
        init?.method === "POST"
      ) {
        manualRefreshes += 1
        return Promise.reject(new Error("diagnostics unavailable"))
      }
      if (
        url === "/api/admin/members/member-1/xero-unlink" &&
        init?.method === "POST"
      ) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              code: "XERO_PARTIAL_SUCCESS",
              error: "private cleanup detail",
              recoveryKind: "CONTACT_UNLINKED",
              xeroContactUnlinked: true,
              xeroLinkMayHaveChanged: true,
              subscriptionCleanupPending: true,
              xeroPostProcessingPending: true,
            }),
            { status: 409 },
          ),
        )
      }
      if (url === "/api/admin/xero/health") {
        return Promise.reject(new Error("diagnostics unavailable"))
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`))
    }) as typeof fetch

    const { rerender } = render(
      <HealthAndDiagnosticsPanels
        connected
        shortCode={null}
        currentXeroPath="/admin/xero"
        healthOpen={false}
        contactGroupMismatchesOpen={false}
        contactLinkMismatchesOpen
        onToggle={vi.fn()}
        onMessage={vi.fn()}
        onRefreshOperations={vi.fn()}
        refreshToken={0}
        scrollToSection={vi.fn()}
      />,
    )

    fireEvent.click(await screen.findByRole("button", { name: "Unlink" }))

    const alert = document.getElementById("xero-contact-link-recovery")
    await waitFor(() =>
      expect(alert).toHaveTextContent(/Diagnostics could not be refreshed/i),
    )
    expect(alert).toHaveTextContent(/link was removed/i)
    expect(alert).not.toHaveTextContent("private cleanup detail")
    await expectRecoveryAlertToHoldFocus(alert)
    expect(screen.queryByRole("button", { name: "Unlink" })).not.toBeInTheDocument()
    const recoveryAction = screen.getByRole("link", {
      name: "Open affected member: Riley Chen",
    })
    expect(alert).toContainElement(recoveryAction)
    expect(recoveryAction).toHaveAttribute(
      "href",
      "/admin/members/member-1?returnTo=%2Fadmin%2Fxero",
    )

    rerender(
      <HealthAndDiagnosticsPanels
        connected
        shortCode={null}
        currentXeroPath="/admin/xero"
        healthOpen={false}
        contactGroupMismatchesOpen={false}
        contactLinkMismatchesOpen
        onToggle={vi.fn()}
        onMessage={vi.fn()}
        onRefreshOperations={vi.fn()}
        refreshToken={1}
        scrollToSection={vi.fn()}
      />,
    )
    const genericError = document.getElementById("xero-contact-link-error")
    await waitFor(() =>
      expect(genericError).toHaveTextContent(/service could not be reached/i),
    )
    expect(alert).toHaveTextContent(/link was removed/i)
    expect(recoveryAction).toBeInTheDocument()

    const manualRefresh = within(
      document.getElementById("xero-section-contactLinkMismatches")!,
    ).getByRole("button", { name: "Refresh" }) as HTMLButtonElement
    await waitFor(() => expect(manualRefresh.disabled).toBe(false))
    fireEvent.click(manualRefresh)
    await waitFor(() => expect(manualRefreshes).toBe(1))
    expect(genericError).toHaveTextContent(/service could not be reached/i)
    expect(alert).toHaveTextContent(/link was removed/i)
    expect(recoveryAction).toBeInTheDocument()
  })
})
