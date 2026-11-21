// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest"
import type { ReactNode } from "react"
import { cleanup, fireEvent, render, screen, waitFor } from "@/lib/__tests__/support/club-time-render"
import { afterEach, describe, expect, it, vi } from "vitest"
import { MemberBulkSubscriptionCategoryDialog } from "../member-bulk-subscription-category-dialog"

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

const CATEGORIES = [
  { id: "cat-couple", key: "couple", name: "Couple", isActive: true },
  { id: "cat-old", key: "old", name: "Old Family", isActive: false },
]

function jsonResponse(body: unknown, ok = true) {
  return { ok, json: async () => body } as Response
}

function previewMember(overrides: Record<string, unknown>) {
  return {
    previewToken: "tok",
    currentCategory: null,
    newCategory: { id: "cat-couple", name: "Couple" },
    changed: true,
    categoryChanged: true,
    currentAgeTier: "ADULT",
    resultingAgeTier: "ADULT",
    ageTierChanged: false,
    linkedGuestBlocked: false,
    linkedGuestBookings: { count: 0 },
    currentSeasonSubscription: { status: "NO_RECORD", hasInvoice: false },
    ...overrides,
  }
}

const previewBody = {
  seasonYear: 2026,
  summary: {
    requested: 3,
    previewed: 2,
    changed: 2,
    unchanged: 0,
    skipped: 1,
    ageTierChanges: 0,
    linkedGuestBlocks: 0,
    alreadyBilled: 1,
  },
  members: [
    previewMember({ memberId: "m1", name: "Alice", previewToken: "tok-1" }),
    previewMember({
      memberId: "m2",
      name: "Bob",
      previewToken: "tok-2",
      currentSeasonSubscription: { status: "PAID", hasInvoice: true },
    }),
  ],
  skipped: [{ memberId: "m3", name: "Cara", reason: "no_membership_type" }],
}

function stubFetch(save: unknown) {
  const calls: Array<{ url: string; body: Record<string, unknown> | null }> = []
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null })
      if (url === "/api/admin/membership-types") {
        return jsonResponse({ membershipTypes: [], currentSeasonYear: 2026 })
      }
      if (url.endsWith("/preview")) return jsonResponse(previewBody)
      return jsonResponse(save)
    }),
  )
  return calls
}

function renderDialog() {
  const onComplete = vi.fn()
  const onError = vi.fn()
  render(
    <MemberBulkSubscriptionCategoryDialog
      open
      selectedIds={new Set(["m1", "m2", "m3"])}
      memberNames={new Map([["m1", "Alice"], ["m2", "Bob"], ["m3", "Cara"]])}
      subscriptionCategories={CATEGORIES}
      onOpenChange={vi.fn()}
      onComplete={onComplete}
      onError={onError}
    />,
  )
  return { onComplete, onError }
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("MemberBulkSubscriptionCategoryDialog (#5248)", () => {
  it("offers Individual and the active categories only", () => {
    stubFetch({})
    renderDialog()

    expect(screen.getByRole("option", { name: "Individual (no category)" })).toBeInTheDocument()
    expect(screen.getByRole("option", { name: "Couple" })).toBeInTheDocument()
    expect(screen.queryByRole("option", { name: /Old Family/ })).not.toBeInTheDocument()
  })

  it("previews who moves, flags the already-billed and skipped, then saves with the preview tokens", async () => {
    const calls = stubFetch({
      outcomeCounts: { changed: 2, unchanged: 0, skipped: 0, stale: 0, blocked_linked_guests: 0, error: 0 },
      results: [
        { memberId: "m1", outcome: "changed" },
        { memberId: "m2", outcome: "changed" },
      ],
    })
    const { onComplete } = renderDialog()

    fireEvent.change(screen.getAllByRole("combobox")[0], { target: { value: "cat-couple" } })
    fireEvent.click(screen.getByRole("button", { name: "Preview" }))

    await waitFor(() => expect(screen.getByText(/2 of 2 will change/)).toBeInTheDocument())
    expect(screen.getAllByText(/Individual → Couple/)).toHaveLength(2)
    expect(screen.getByText(/already paid or invoiced/)).toBeInTheDocument()
    expect(screen.getByText(/assign one from their profile first/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "Continue" }))
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: "couples" } })
    fireEvent.click(screen.getByRole("button", { name: "Confirm change" }))
    await waitFor(() => expect(screen.getByRole("button", { name: "Done" })).toBeInTheDocument())

    const save = calls.find((call) => call.url === "/api/admin/members/bulk-subscription-category")
    expect(save?.body).toEqual({
      ids: ["m1", "m2"],
      seasonYear: 2026,
      subscriptionCategoryId: "cat-couple",
      reason: "couples",
      previewTokens: { m1: "tok-1", m2: "tok-2" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Done" }))
    expect(onComplete).toHaveBeenCalledWith(2)
  })

  it("sends null, never an empty string or an omitted field, to clear to Individual", async () => {
    const calls = stubFetch({})
    renderDialog()

    fireEvent.change(screen.getAllByRole("combobox")[0], {
      target: { value: "__individual__" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Preview" }))
    await waitFor(() => expect(calls.some((call) => call.url.endsWith("/preview"))).toBe(true))

    const preview = calls.find((call) => call.url.endsWith("/preview"))
    expect(preview?.body).toEqual({
      ids: ["m1", "m2", "m3"],
      seasonYear: 2026,
      subscriptionCategoryId: null,
    })
  })
})
