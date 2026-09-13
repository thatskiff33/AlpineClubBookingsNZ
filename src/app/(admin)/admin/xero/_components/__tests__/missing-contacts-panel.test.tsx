// @vitest-environment jsdom

/**
 * The missing-contact panel (#2939). `INV-INT-022`.
 *
 * Two properties are worth a browser-shaped test rather than a reading of the
 * component: that the confirmation posts the member ids the operator was
 * actually shown — which is the half of the rule the SERVER cannot supply,
 * since it only ever narrows what it is given — and that a member the census
 * handed back as ambiguous appears with a reason instead of silently not being
 * in the list. A panel that dropped the ambiguous rows would look identical to
 * one that had none.
 */

import "@testing-library/jest-dom/vitest"
import { fireEvent, render, screen, waitFor } from "@/lib/__tests__/support/club-time-render"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { MissingContactsPanel } from "../missing-contacts-panel"

// PARTIAL: `view-only-action.tsx` reads `ADMIN_VIEW_ONLY_ACTION_REASON` from
// this same module, so replacing it wholesale takes the shared refusal copy
// with it and every gated button throws on render.
vi.mock("@/hooks/use-admin-area-edit-access", async (importOriginal) => {
  const actual =
    (await importOriginal()) as typeof import("@/hooks/use-admin-area-edit-access")
  return { ...actual, useAdminAreaEditAccess: () => true }
})

const snapshot = {
  cacheReady: true,
  contactCacheLastRefreshedAt: "2026-06-01T00:00:00.000Z",
  eligible: 3,
  alreadyLinked: 0,
  unlinked: 3,
  pushable: 2,
  excluded: 0,
  ambiguous: 1,
  pushableRows: [
    {
      memberId: "member-1",
      memberName: "Riley Chen",
      memberEmail: "riley@example.test",
      evidence: "NO_CACHED_MATCH",
      cachedXeroContactId: null,
    },
    {
      memberId: "member-2",
      memberName: "Sam Patel",
      memberEmail: "sam@example.test",
      evidence: "CACHED_CONTACT_MATCH",
      cachedXeroContactId: "xero-contact-2",
    },
  ],
  excludedRows: [],
  ambiguousRows: [
    {
      memberId: "member-3",
      memberName: "Alex Ngata",
      memberEmail: "office@school.test",
      reason: "XERO_CONTACT_BELONGS_TO_A_SCHOOL",
      xeroContactIds: ["xero-contact-school"],
    },
  ],
}

const runResult = {
  processed: 2,
  linkedExisting: 1,
  created: 1,
  resolvedUnlabelled: 0,
  failed: 0,
  failures: [],
  skippedNoLongerPushable: [],
  remaining: 0,
  done: true,
  haltedByDailyLimit: false,
}

function renderPanel() {
  return render(
    <MissingContactsPanel
      connected
      open
      onToggle={vi.fn()}
      currentXeroPath="/admin/xero"
      shortCode={null}
      onMessage={vi.fn()}
      onRefreshOperations={vi.fn()}
    />,
  )
}

beforeEach(() => {
  vi.restoreAllMocks()
})

describe("the missing-contact panel (#2939)", () => {
  it("shows what the dry run found, including who it will not decide for", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ snapshot, notReadyMessage: null }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    )

    renderPanel()
    fireEvent.click(screen.getByRole("button", { name: /run the dry run/i }))

    await waitFor(() => {
      expect(screen.getByText(/2 ready to create or link/i)).toBeInTheDocument()
    })
    expect(screen.getByText("Alex Ngata")).toBeInTheDocument()
    expect(
      screen.getByText(/only Xero contact with this email address is a school's customer/i),
    ).toBeInTheDocument()
  })

  it("confirms with exactly the member ids it showed, and nobody else", async () => {
    const calls: Array<{ url: string; body: unknown }> = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({
          url,
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        })
        const payload =
          init?.method === "POST"
            ? { result: runResult }
            : { snapshot, notReadyMessage: null }
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      }),
    )

    renderPanel()
    fireEvent.click(screen.getByRole("button", { name: /run the dry run/i }))
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /create the next 2 of 2/i })).toBeEnabled()
    })
    fireEvent.click(screen.getByRole("button", { name: /create the next 2 of 2/i }))

    await waitFor(() => {
      expect(calls.some((call) => call.body !== undefined)).toBe(true)
    })
    const post = calls.find((call) => call.body !== undefined)
    expect(post?.body).toEqual({
      confirmReviewed: true,
      // The two pushable rows, and NOT the ambiguous one that was on screen
      // beside them.
      memberIds: ["member-1", "member-2"],
    })
  })

  it("says what to do when Xero contacts have never been synced", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            snapshot: { ...snapshot, cacheReady: false, pushable: 0, pushableRows: [] },
            notReadyMessage: "Run Contact Sync first, then come back.",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    )

    renderPanel()
    fireEvent.click(screen.getByRole("button", { name: /run the dry run/i }))

    await waitFor(() => {
      expect(screen.getByText(/Run Contact Sync first/i)).toBeInTheDocument()
    })
    // No confirmation is offered against counts that were never computed.
    expect(screen.queryByRole("button", { name: /create the next/i })).toBeNull()
  })
})
