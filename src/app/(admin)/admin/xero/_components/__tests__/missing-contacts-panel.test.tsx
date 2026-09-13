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
  contactCacheAgeHours: 2,
  contactCacheStale: false,
  plannedDigest: "digest-of-the-reviewed-plan",
  chunkSize: 15,
  estimatedXeroCallsPerChunk: 4,
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
  outcomes: [
    {
      memberId: "member-1",
      memberName: "Riley Chen",
      memberEmail: "riley@example.test",
      outcome: "created",
      xeroContactId: "xero-contact-new",
      plannedEvidence: "NO_CACHED_MATCH",
      kind: null,
      error: null,
    },
    {
      memberId: "member-2",
      memberName: "Sam Patel",
      memberEmail: "sam@example.test",
      outcome: "linked",
      xeroContactId: "xero-contact-2",
      plannedEvidence: "CACHED_CONTACT_MATCH",
      kind: null,
      error: null,
    },
  ],
  skipped: [],
  remaining: 0,
  outstandingPushable: 0,
  done: true,
  haltedByDailyLimit: false,
  haltedByTimeBudget: false,
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
  it("takes the batch size from the server rather than hardcoding it", async () => {
    // The label is the only place an operator learns the batch size, and it
    // used to be a literal 25 while the route imported a constant. The size now
    // depends on whether contact grouping is on, so a literal cannot be right.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            snapshot: {
              ...snapshot,
              pushable: 40,
              chunkSize: 7,
              pushableRows: snapshot.pushableRows,
            },
            notReadyMessage: null,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    )

    renderPanel()
    fireEvent.click(screen.getByRole("button", { name: /run the dry run/i }))

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /create the next 7 of 40/i }),
      ).toBeInTheDocument()
    })
  })

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

    /*
      THE CONFIRMATION IS A DIALOG, and it restates the split rather than just
      the total — "explicit confirmation" was one click on the primary button
      until #2939's review, which proved nothing about what a human saw. Every
      other write on this page goes through this same shared confirm.
    */
    const dialogButton = await screen.findByRole("button", {
      name: /create 1 and link 1/i,
    })
    expect(screen.getByText(/writes to the club's real Xero organisation/i)).toBeInTheDocument()
    fireEvent.click(dialogButton)

    await waitFor(() => {
      expect(calls.some((call) => call.body !== undefined)).toBe(true)
    })
    const post = calls.find((call) => call.body !== undefined)
    expect(post?.body).toEqual({
      confirmReviewed: true,
      // The two pushable rows, and NOT the ambiguous one that was on screen
      // beside them.
      memberIds: ["member-1", "member-2"],
      // …and the digest of the plan those ids were reviewed against, which is
      // what lets the server refuse a run whose plan moved underneath them.
      plannedDigest: "digest-of-the-reviewed-plan",
    })
  })

  it("does not post anything if the operator backs out of the confirmation", async () => {
    const calls: Array<{ url: string; body: unknown }> = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({
          url,
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        })
        return new Response(JSON.stringify({ snapshot, notReadyMessage: null }), {
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

    fireEvent.click(await screen.findByRole("button", { name: /^cancel$/i }))

    await waitFor(() => {
      expect(screen.queryByText(/writes to the club's real Xero organisation/i)).toBeNull()
    })
    expect(calls.every((call) => call.body === undefined)).toBe(true)
  })

  it("names every member it touched, and which Xero contact they ended up on", async () => {
    /*
      Counts are not a report. "One created, one linked" says nothing about
      WHICH contact each member was linked to, and that is the one thing a
      silently wrong adoption would show up in.
    */
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) =>
        new Response(
          JSON.stringify(
            init?.method === "POST"
              ? { result: runResult }
              : { snapshot, notReadyMessage: null },
          ),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    )

    renderPanel()
    fireEvent.click(screen.getByRole("button", { name: /run the dry run/i }))
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /create the next 2 of 2/i })).toBeEnabled()
    })
    fireEvent.click(screen.getByRole("button", { name: /create the next 2 of 2/i }))
    fireEvent.click(await screen.findByRole("button", { name: /create 1 and link 1/i }))

    // The outcome line is assembled from several nodes (name, address, then the
    // sentence), so it is matched on the LIST ITEM's text rather than on a
    // single text node.
    const outcomeText = async () => {
      const items = await screen.findAllByRole("listitem")
      return items.map((item) => item.textContent ?? "")
    }

    await waitFor(async () => {
      expect(
        (await outcomeText()).some(
          (text) =>
            text.includes("Riley Chen") && text.includes("given a new Xero contact"),
        ),
      ).toBe(true)
    })
    expect(
      (await outcomeText()).some(
        (text) =>
          text.includes("Sam Patel") &&
          text.includes("linked to a contact Xero already had"),
      ),
    ).toBe(true)
  })

  it("warns when the cached contact list is old enough to mislead", async () => {
    // Freshness was checked for EXISTENCE and never for age, and age is exactly
    // what turns a "no Xero contact found" row into a duplicate.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            snapshot: {
              ...snapshot,
              contactCacheAgeHours: 30 * 24,
              contactCacheStale: true,
            },
            notReadyMessage: null,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    )

    renderPanel()
    fireEvent.click(screen.getByRole("button", { name: /run the dry run/i }))

    await waitFor(() => {
      expect(screen.getByText(/30 days ago/i)).toBeInTheDocument()
    })
    expect(screen.getByText(/old enough to be wrong/i)).toBeInTheDocument()
  })

  it("says why the panel is dead when Xero is disconnected", async () => {
    /*
      A full admin with Xero disconnected got a dead button and no explanation:
      the dry-run button passed a connection reason AND suppressed the channel
      that renders it, while the section banner is conditioned on the finance
      permission. The reason is a visible paragraph now rather than a `title`
      that never fires on a `pointer-events-none` disabled button.
    */
    render(
      <MissingContactsPanel
        connected={false}
        open
        onToggle={vi.fn()}
        currentXeroPath="/admin/xero"
        shortCode={null}
        onMessage={vi.fn()}
        onRefreshOperations={vi.fn()}
      />,
    )

    expect(screen.getByText(/Xero is not connected, so nothing on this panel can run/i))
      .toBeInTheDocument()
    expect(screen.getByRole("button", { name: /run the dry run/i })).toBeDisabled()
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
