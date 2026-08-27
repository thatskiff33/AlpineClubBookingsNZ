// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest"
import { fireEvent, render, screen, waitFor } from "@/lib/__tests__/support/club-time-render"
import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { BookingApprovalsPanel } from "../booking-approvals-panel"
import { expectRecoveryAlertToHoldFocus } from "@/lib/__tests__/helpers/focus"

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}))

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}))

vi.mock("sonner", () => ({ toast: { success: vi.fn() } }))

const booking = {
  id: "booking-1",
  checkIn: "2026-08-10",
  checkOut: "2026-08-12",
  status: "AWAITING_REVIEW",
  finalPriceCents: 12000,
  memberReviewJustification: "No adult host is available.",
  adminReviewStatus: "PENDING",
  adminReviewNotes: null,
  adminReviewedAt: null,
  createdAt: "2026-08-01T00:00:00.000Z",
  noEmails: false,
  member: {
    id: "member-1",
    firstName: "Riley",
    lastName: "Chen",
    email: "riley@example.org",
  },
  adminReviewedBy: null,
  guests: [
    {
      id: "guest-1",
      firstName: "Riley",
      lastName: "Chen",
      ageTier: "YOUTH",
      isMember: true,
    },
  ],
}

describe("BookingApprovalsPanel action error attention (#2597)", () => {
  const originalScrollIntoView = HTMLElement.prototype.scrollIntoView
  let scrollIntoView: ReturnType<typeof vi.fn>

  beforeEach(() => {
    scrollIntoView = vi.fn()
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    })
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [booking] }),
    }) as unknown as typeof fetch
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

  it("keeps the alert mounted and focuses a decision failure", async () => {
    render(<BookingApprovalsPanel />)

    const alert = document.getElementById("booking-approvals-error")
    expect(alert).toHaveAttribute("role", "alert")
    expect(alert).toBeEmptyDOMElement()
    expect(alert).toHaveClass("sr-only")

    fireEvent.click(
      await screen.findByRole("button", { name: "Reject and cancel" }),
    )

    await waitFor(() =>
      expect(alert).toHaveTextContent(/add admin notes before rejecting/i),
    )
    await expectRecoveryAlertToHoldFocus(alert)
    expect(scrollIntoView).toHaveBeenCalledWith({
      behavior: "smooth",
      block: "center",
    })
  })

  it("retains ordinary recorded-rejection recovery, suppresses stale reject, and links back to the queue", async () => {
    let reviewReads = 0
    const secondBooking = {
      ...booking,
      id: "booking-2",
      member: {
        ...booking.member,
        id: "member-2",
        firstName: "Jordan",
        lastName: "Singh",
        email: "jordan@example.org",
      },
    }
    global.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith("/api/admin/booking-reviews?")) {
        reviewReads += 1
        if (reviewReads === 1) {
          return {
            ok: true,
            json: async () => ({ data: [booking, secondBooking] }),
          } as Response
        }
        return {
          ok: false,
          json: async () => ({ error: "refresh unavailable" }),
        } as Response
      }
      if (url === "/api/admin/bookings/booking-1/review" && init?.method === "PATCH") {
        return {
          ok: false,
          status: 500,
          json: async () => ({
            error: "private database detail",
            reviewRecorded: true,
            cancellationStatusUnconfirmed: true,
          }),
        } as Response
      }
      throw new Error(`Unexpected request: ${url}`)
    }) as typeof fetch

    render(<BookingApprovalsPanel />)
    const notes = await screen.findAllByPlaceholderText(/Explain your decision/i)
    fireEvent.change(
      notes[0],
      { target: { value: "No eligible adult host." } },
    )
    fireEvent.click(screen.getAllByRole("button", { name: "Reject and cancel" })[0])
    fireEvent.click(
      await screen.findByRole("button", { name: "Reject and email member" }),
    )

    const recoveryAlert = document.getElementById("booking-approvals-recovery")
    const actionAlert = document.getElementById("booking-approvals-error")
    await waitFor(() =>
      expect(recoveryAlert).toHaveTextContent(/rejection was recorded/i),
    )
    expect(recoveryAlert).toHaveTextContent(/cancellation status could not be confirmed/i)
    expect(recoveryAlert).toHaveTextContent(/could not be refreshed/i)
    expect(recoveryAlert).not.toHaveTextContent("private database detail")
    await expectRecoveryAlertToHoldFocus(recoveryAlert)
    expect(screen.queryByText("Riley Chen")).not.toBeInTheDocument()
    const recoveryLink = screen.getByRole("link", { name: "Open affected booking" })
    expect(recoveryLink).toHaveAttribute(
      "href",
      "/bookings/booking-1?returnTo=%2Fadmin%2Fbooking-requests",
    )

    fireEvent.click(screen.getByRole("button", { name: "Reject and cancel" }))
    await waitFor(() =>
      expect(actionAlert).toHaveTextContent(/add admin notes before rejecting/i),
    )
    await expectRecoveryAlertToHoldFocus(actionAlert)
    expect(recoveryAlert).toHaveTextContent(/rejection was recorded/i)
  })
})
