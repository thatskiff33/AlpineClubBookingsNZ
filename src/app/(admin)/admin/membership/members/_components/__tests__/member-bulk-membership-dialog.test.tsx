// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest"
import type { ReactNode } from "react"
import { cleanup, fireEvent, render, screen, waitFor } from "@/lib/__tests__/support/club-time-render"
import { afterEach, describe, expect, it, vi } from "vitest"
import { MemberBulkMembershipDialog } from "../member-bulk-membership-dialog"

vi.mock("@/components/ui/select", () => ({
  Select: ({
    value,
    onValueChange,
    children,
  }: {
    value: string
    onValueChange: (value: string) => void
    children: ReactNode
  }) => (
    <select value={value} onChange={(event) => onValueChange(event.target.value)}>
      {children}
    </select>
  ),
  SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: ReactNode }) => (
    <option value={value}>{children}</option>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
}))

const TYPES = {
  membershipTypes: [
    { id: "type-a", name: "Full", isActive: true },
    { id: "type-b", name: "Archived", isActive: false },
  ],
}

function jsonResponse(body: unknown, ok = true) {
  return { ok, json: async () => body } as Response
}

function routedFetch(handlers: {
  types?: unknown
  preview?: unknown
  save?: unknown
}) {
  return vi.fn(async (url: string) => {
    if (url === "/api/admin/membership-types") return jsonResponse(handlers.types ?? TYPES)
    if (url.endsWith("/preview")) return jsonResponse(handlers.preview ?? {})
    return jsonResponse(handlers.save ?? {})
  })
}

const previewBody = {
  seasonYear: 2026,
  membershipTypeId: "type-a",
  summary: {
    requested: 2,
    previewed: 2,
    changed: 2,
    unchanged: 0,
    skipped: 0,
    ageTierChanges: 0,
    linkedGuestBlocks: 0,
    affectedTotals: { futureConfirmedBookings: 3, draftBookings: 0, waitlistRecords: 0 },
  },
  members: [
    {
      memberId: "m1",
      name: "Alice",
      previewToken: "tok-1",
      affectedCounts: { futureConfirmedBookings: 3, draftBookings: 0, waitlistRecords: 0 },
      changed: true,
      currentAgeTier: "ADULT",
      resultingAgeTier: "ADULT",
      ageTierChanged: false,
      linkedGuestBlocked: false,
      linkedGuestBookings: { count: 0 },
    },
    {
      memberId: "m2",
      name: "Bob",
      previewToken: "tok-2",
      affectedCounts: { futureConfirmedBookings: 0, draftBookings: 0, waitlistRecords: 0 },
      changed: true,
      currentAgeTier: "ADULT",
      resultingAgeTier: "ADULT",
      ageTierChanged: false,
      linkedGuestBlocked: false,
      linkedGuestBookings: { count: 0 },
    },
  ],
  skipped: [],
}

function renderDialog(overrides: Partial<Record<string, unknown>> = {}) {
  const onComplete = vi.fn()
  const onError = vi.fn()
  render(
    <MemberBulkMembershipDialog
      open
      selectedIds={new Set(["m1", "m2"])}
      memberNames={new Map([["m1", "Alice"], ["m2", "Bob"]])}
      onOpenChange={vi.fn()}
      onComplete={onComplete}
      onError={onError}
      {...overrides}
    />,
  )
  return { onComplete, onError }
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("MemberBulkMembershipDialog (#2107)", () => {
  it("walks preview → reason → confirm and reports the changed count", async () => {
    vi.stubGlobal(
      "fetch",
      routedFetch({
        preview: previewBody,
        save: {
          outcomeCounts: { changed: 2, unchanged: 0, stale: 0, blocked_linked_guests: 0, error: 0 },
          results: [
            { memberId: "m1", outcome: "changed" },
            { memberId: "m2", outcome: "changed" },
          ],
        },
      }),
    )

    const { onComplete } = renderDialog()

    // Only the ACTIVE type is offered.
    await waitFor(() => expect(screen.getByRole("option", { name: "Full" })).toBeInTheDocument())
    expect(screen.queryByRole("option", { name: "Archived" })).not.toBeInTheDocument()

    // Pick the type (first combobox) and preview.
    fireEvent.change(screen.getAllByRole("combobox")[0], { target: { value: "type-a" } })
    fireEvent.click(screen.getByRole("button", { name: "Preview" }))

    await waitFor(() =>
      expect(screen.getByText(/2 of 2 will change/)).toBeInTheDocument(),
    )
    expect(screen.getByText(/Existing bookings are not repriced/)).toBeInTheDocument()

    // Reason step → confirm.
    fireEvent.click(screen.getByRole("button", { name: "Continue" }))
    fireEvent.change(screen.getByLabelText(/Reason/), {
      target: { value: "season start" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Confirm change" }))

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Done" })).toBeInTheDocument(),
    )
    fireEvent.click(screen.getByRole("button", { name: "Done" }))
    expect(onComplete).toHaveBeenCalledWith(2)
  })

  it("offers Preview again when a save returns stale outcomes", async () => {
    vi.stubGlobal(
      "fetch",
      routedFetch({
        preview: previewBody,
        save: {
          outcomeCounts: { changed: 1, unchanged: 0, stale: 1, blocked_linked_guests: 0, error: 0 },
          results: [
            { memberId: "m1", outcome: "changed" },
            { memberId: "m2", outcome: "stale", error: "Preview again" },
          ],
        },
      }),
    )

    renderDialog()

    await waitFor(() => expect(screen.getByRole("option", { name: "Full" })).toBeInTheDocument())
    fireEvent.change(screen.getAllByRole("combobox")[0], { target: { value: "type-a" } })
    fireEvent.click(screen.getByRole("button", { name: "Preview" }))
    await waitFor(() => expect(screen.getByText(/2 of 2 will change/)).toBeInTheDocument())
    fireEvent.click(screen.getByRole("button", { name: "Continue" }))
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: "season start" } })
    fireEvent.click(screen.getByRole("button", { name: "Confirm change" }))

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Preview again" })).toBeInTheDocument(),
    )
    // The stale member is surfaced with its name for re-preview.
    expect(screen.getByText("Bob")).toBeInTheDocument()

    // Preview again re-runs the preview and returns to the preview step.
    fireEvent.click(screen.getByRole("button", { name: "Preview again" }))
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Continue" })).toBeInTheDocument(),
    )
  })

  it("re-previews with FRESH tokens and a fresh preview fetch before a second save", async () => {
    const previewBody2 = {
      ...previewBody,
      members: previewBody.members.map((member) => ({
        ...member,
        previewToken: `${member.previewToken}-b`,
      })),
    }
    const staleSave = {
      outcomeCounts: { changed: 1, unchanged: 0, stale: 1, blocked_linked_guests: 0, error: 0 },
      results: [
        { memberId: "m1", name: "Alice", outcome: "changed" },
        { memberId: "m2", name: "Bob", outcome: "stale", error: "Preview again" },
      ],
    }
    const okSave = {
      outcomeCounts: { changed: 2, unchanged: 0, stale: 0, blocked_linked_guests: 0, error: 0 },
      results: [
        { memberId: "m1", name: "Alice", outcome: "changed" },
        { memberId: "m2", name: "Bob", outcome: "changed" },
      ],
    }
    let previewCalls = 0
    const saveBodies: Array<Record<string, unknown>> = []
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/admin/membership-types") return jsonResponse(TYPES)
      if (url.endsWith("/preview")) {
        previewCalls += 1
        return jsonResponse(previewCalls === 1 ? previewBody : previewBody2)
      }
      saveBodies.push(JSON.parse(String(init?.body)))
      return jsonResponse(saveBodies.length === 1 ? staleSave : okSave)
    })
    vi.stubGlobal("fetch", fetchMock)

    renderDialog()

    await waitFor(() => expect(screen.getByRole("option", { name: "Full" })).toBeInTheDocument())
    fireEvent.change(screen.getAllByRole("combobox")[0], { target: { value: "type-a" } })
    fireEvent.click(screen.getByRole("button", { name: "Preview" }))
    await waitFor(() => expect(screen.getByText(/2 of 2 will change/)).toBeInTheDocument())
    fireEvent.click(screen.getByRole("button", { name: "Continue" }))
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: "season start" } })
    fireEvent.click(screen.getByRole("button", { name: "Confirm change" }))

    // First save used the original tokens.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Preview again" })).toBeInTheDocument(),
    )
    expect(saveBodies[0].previewTokens).toEqual({ m1: "tok-1", m2: "tok-2" })

    // Re-preview (fresh fetch) then save again.
    fireEvent.click(screen.getByRole("button", { name: "Preview again" }))
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Continue" })).toBeInTheDocument(),
    )
    fireEvent.click(screen.getByRole("button", { name: "Continue" }))
    fireEvent.click(screen.getByRole("button", { name: "Confirm change" }))
    await waitFor(() => expect(saveBodies.length).toBe(2))

    // A second preview fetch fired, and the second save carried the FRESH tokens.
    expect(previewCalls).toBe(2)
    expect(saveBodies[1].previewTokens).toEqual({ m1: "tok-1-b", m2: "tok-2-b" })
  })

  it("caps the selection at 100 members with an inline note and a disabled Preview", async () => {
    vi.stubGlobal("fetch", routedFetch({}))
    const ids = new Set(Array.from({ length: 101 }, (_, i) => `m-${i}`))
    render(
      <MemberBulkMembershipDialog
        open
        selectedIds={ids}
        memberNames={new Map()}
        onOpenChange={vi.fn()}
        onComplete={vi.fn()}
        onError={vi.fn()}
      />,
    )
    await waitFor(() => expect(screen.getByRole("option", { name: "Full" })).toBeInTheDocument())
    expect(
      screen.getByText(/limited to 100 members at a time/i),
    ).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Preview" })).toBeDisabled()
  })

  it("surfaces a membership-types load error via onError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/api/admin/membership-types") return jsonResponse({}, false)
        return jsonResponse({})
      }),
    )
    const { onError } = renderDialog()
    await waitFor(() =>
      expect(onError).toHaveBeenCalledWith("Failed to load membership types"),
    )
  })

  it("keeps Confirm disabled for a whitespace-only reason", async () => {
    vi.stubGlobal("fetch", routedFetch({ preview: previewBody }))
    renderDialog()
    await waitFor(() => expect(screen.getByRole("option", { name: "Full" })).toBeInTheDocument())
    fireEvent.change(screen.getAllByRole("combobox")[0], { target: { value: "type-a" } })
    fireEvent.click(screen.getByRole("button", { name: "Preview" }))
    await waitFor(() => expect(screen.getByText(/2 of 2 will change/)).toBeInTheDocument())
    fireEvent.click(screen.getByRole("button", { name: "Continue" }))
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: "   " } })
    expect(screen.getByRole("button", { name: "Confirm change" })).toBeDisabled()
  })

  it("disables Continue when the preview reports zero changes", async () => {
    const noChange = {
      ...previewBody,
      summary: { ...previewBody.summary, changed: 0, unchanged: 2 },
      members: previewBody.members.map((member) => ({ ...member, changed: false })),
    }
    vi.stubGlobal("fetch", routedFetch({ preview: noChange }))
    renderDialog()
    await waitFor(() => expect(screen.getByRole("option", { name: "Full" })).toBeInTheDocument())
    fireEvent.change(screen.getAllByRole("combobox")[0], { target: { value: "type-a" } })
    fireEvent.click(screen.getByRole("button", { name: "Preview" }))
    await waitFor(() => expect(screen.getByText(/0 of 2 will change/)).toBeInTheDocument())
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled()
  })

  it("renders blocked linked-guest booking labels in the preview and the results", async () => {
    const blockedPreview = {
      ...previewBody,
      summary: {
        ...previewBody.summary,
        changed: 1,
        unchanged: 0,
        linkedGuestBlocks: 1,
      },
      members: [
        previewBody.members[0],
        {
          ...previewBody.members[1],
          changed: false,
          linkedGuestBlocked: true,
          linkedGuestBookings: {
            count: 2,
            truncatedCount: 0,
            list: [
              {
                bookingGuestId: "bg-1",
                bookingId: "bk-1",
                ownerMemberId: "owner-1",
                checkIn: "2099-08-01",
                checkOut: "2099-08-03",
                stayStart: "2099-08-01",
                stayEnd: "2099-08-03",
              },
            ],
          },
        },
      ],
    }
    vi.stubGlobal(
      "fetch",
      routedFetch({
        preview: blockedPreview,
        save: {
          outcomeCounts: { changed: 1, unchanged: 0, stale: 0, blocked_linked_guests: 1, error: 0 },
          results: [
            { memberId: "m1", name: "Alice", outcome: "changed" },
            {
              memberId: "m2",
              name: "Bob",
              outcome: "blocked_linked_guests",
              error: "Linked guest",
              linkedGuestBookings: {
                count: 1,
                truncatedCount: 0,
                list: [
                  {
                    bookingGuestId: "bg-1",
                    bookingId: "bk-1",
                    ownerMemberId: "owner-1",
                    checkIn: "2099-08-01",
                    checkOut: "2099-08-03",
                    stayStart: "2099-08-01",
                    stayEnd: "2099-08-03",
                  },
                ],
              },
            },
          ],
        },
      }),
    )
    renderDialog()
    await waitFor(() => expect(screen.getByRole("option", { name: "Full" })).toBeInTheDocument())
    fireEvent.change(screen.getAllByRole("combobox")[0], { target: { value: "type-a" } })
    fireEvent.click(screen.getByRole("button", { name: "Preview" }))

    // Preview step shows the linked-guest booking label under the blocked member.
    await waitFor(() =>
      expect(screen.getByText("2099-08-01 → 2099-08-03")).toBeInTheDocument(),
    )

    // Walk through to the results step; the label appears there too.
    fireEvent.click(screen.getByRole("button", { name: "Continue" }))
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: "flip to exempt" } })
    fireEvent.click(screen.getByRole("button", { name: "Confirm change" }))
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Done" })).toBeInTheDocument(),
    )
    expect(screen.getByText("2099-08-01 → 2099-08-03")).toBeInTheDocument()
  })
})
