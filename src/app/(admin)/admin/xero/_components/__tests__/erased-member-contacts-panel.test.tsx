// @vitest-environment jsdom

/**
 * The erased-member Xero contact panel (#3058). `INV-INT-024`.
 *
 * The properties worth a browser-shaped test here, and the first is the one the
 * whole issue turns on.
 *
 * The panel must not read as a to-do list of things the club has to delete from
 * Xero. That is not a style preference: the settled contract is that this
 * application makes no claim about what Xero should hold, so a screen implying
 * otherwise would be the feature shipping the exact instruction it was created
 * to avoid giving. It is asserted on the rendered text because that is what an
 * officer reads — including the EMPHASIS, because an earlier revision bolded
 * the backlog count and left the load-bearing sentence in grey above it, so a
 * treasurer skimming took away a bolded number.
 *
 * Second, a hard-deleted member must not be offered a member-page link. There
 * is no row left, so the link would be a 404 dressed as a destination — and the
 * two erasure kinds are otherwise indistinguishable on the screen.
 *
 * Third, nothing on the panel may change anything IN XERO. The one control that
 * reaches Xero asks it a question. It is not free, though — it spends the
 * club's metered Xero allowance and writes what Xero said onto the retired
 * CONTACT link here — so it is gated at `finance:edit` like the route behind
 * it, while the list stays readable at `finance:view`.
 *
 * Fourth, the erasure DATE is derived through the club-time kernel. An earlier
 * revision sliced ten characters off the UTC instant, which renders the day
 * before for most of the New Zealand working day — on a list sold on working
 * oldest-first by date.
 */

import "@testing-library/jest-dom/vitest"
import { fireEvent, render, screen, waitFor } from "@/lib/__tests__/support/club-time-render"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { ErasedMemberContactsPanel } from "../erased-member-contacts-panel"

// PARTIAL: `view-only-action.tsx` reads `ADMIN_VIEW_ONLY_ACTION_REASON` from
// this same module, so replacing it wholesale takes the shared refusal copy
// with it and every gated button throws on render.
const editAccess = vi.hoisted(() => ({ canEdit: true as boolean | undefined }))
vi.mock("@/hooks/use-admin-area-edit-access", async (importOriginal) => {
  const actual =
    (await importOriginal()) as typeof import("@/hooks/use-admin-area-edit-access")
  return { ...actual, useAdminAreaEditAccess: () => editAccess.canEdit }
})

const review = {
  needsReview: 2,
  alreadyRetiredInXero: 1,
  rows: [
    {
      memberId: "member-anon",
      xeroContactId: "xero-contact-anon",
      erasure: "ANONYMISED_BY_DELETION_REQUEST" as const,
      // 16:30 UTC on 4 March is already 05:30 on 5 March at the club, so a
      // naive `slice(0, 10)` prints "2026-03-04" and the panel is a day out.
      erasedAt: "2026-03-04T16:30:00.000Z",
      contactStatus: "ACTIVE" as const,
      contactStatusCheckedAt: "2026-06-20T00:00:00.000Z",
    },
    {
      memberId: "member-gone",
      xeroContactId: "xero-contact-gone",
      erasure: "HARD_DELETED" as const,
      erasedAt: "2026-04-05T00:00:00.000Z",
      contactStatus: "UNKNOWN" as const,
      contactStatusCheckedAt: null,
    },
  ],
  truncated: false,
  lastContactStatusCheckAt: "2026-06-20T00:00:00.000Z",
  contactCacheLastRefreshedAt: "2026-06-01T00:00:00.000Z",
  contactCacheAgeHours: 2,
  contactCacheStale: false,
}

function renderPanel(body: unknown = { review }) {
  const fetchMock = vi.fn(
    async (_url: string, _init?: RequestInit) =>
      ({ ok: true, json: async () => body }) as unknown as Response,
  )
  vi.stubGlobal("fetch", fetchMock)
  render(
    <ErasedMemberContactsPanel
      open
      onToggle={() => {}}
      currentXeroPath="/admin/xero"
      shortCode="ABC123"
    />,
  )
  return fetchMock
}

describe("erased-member Xero contact panel (#3058)", () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    editAccess.canEdit = true
  })

  it("does not offer a view-only officer the check that spends Xero budget", async () => {
    /*
      The route takes `finance:edit` on the POST — it spends the club's metered
      Xero allowance and stamps what Xero said onto the retired CONTACT link —
      so a view-only officer pressing this would get a 403 from a live-looking
      button. The list itself stays readable, which is the point of the panel.
    */
    editAccess.canEdit = false
    renderPanel()
    await screen.findByText(/2 contacts to look at/i)

    expect(screen.getByRole("button", { name: /check these in xero/i })).toBeDisabled()
    // Refresh re-reads local state and costs nothing, so it stays live.
    expect(screen.getByRole("button", { name: /^refresh$/i })).not.toBeDisabled()
    // And the reason is said once, in the reading order, rather than in a title
    // on a `disabled:pointer-events-none` control where it never fires.
    expect(
      screen.getByText(/spends the club's Xero API allowance/i),
    ).toBeInTheDocument()
  })

  it("leaves the check live for an officer who may edit finance", async () => {
    renderPanel()
    await screen.findByText(/2 contacts to look at/i)

    expect(
      screen.getByRole("button", { name: /check these in xero/i }),
    ).not.toBeDisabled()
    expect(screen.queryByText(/spends the club's Xero API allowance/i)).toBeNull()
  })

  it("emphasises that the club is not being asked to remove anything", async () => {
    renderPanel()
    await screen.findByText(/2 contacts to look at/i)

    const headline = screen.getByText(/not asking for anything to be removed from Xero/i)
    expect(headline).toBeInTheDocument()
    /*
      The ONE emphasised thing. If the count is bolded and this is not, the
      panel's own design goal is inverted — which is what shipped before.
    */
    expect(headline.className).toContain("font-medium")
    expect(screen.getByText(/2 contacts to look at/i).className).not.toContain("font-medium")
    expect(
      screen.getByText(/decision for whoever\s+administers Xero/i),
    ).toBeInTheDocument()
  })

  it("does not claim erasure changes nothing at all in Xero", async () => {
    /*
      It DOES change something: erasure cancels the member's future bookings,
      and cancelling a paid one raises a credit note. The true, narrower claim
      is about the contact, and the panel must make that one instead.
    */
    renderPanel()
    await screen.findByText(/2 contacts to look at/i)

    expect(screen.queryByText(/never edits, archives or deletes anything in/i)).toBeNull()
    expect(screen.queryByText(/removes their details from this application and does nothing else/i)).toBeNull()
    expect(
      screen.getByText(/does not ask Xero to\s+change, archive or delete their contact/i),
    ).toBeInTheDocument()
  })

  it("renders the erasure date on the club's calendar, not UTC's", async () => {
    renderPanel()
    await screen.findByText(/2 contacts to look at/i)

    // 2026-03-04T16:30Z is 5 March at the club. The naive slice printed 4 March.
    expect(screen.getByText(/Erased 5 Mar 2026/i)).toBeInTheDocument()
    expect(screen.queryByText(/Erased 2026-03-04/)).toBeNull()
  })

  it("links an anonymised member to their record and a hard-deleted one to nothing", async () => {
    renderPanel()
    await screen.findByText(/2 contacts to look at/i)

    const anonymised = screen.getByText("member-anon")
    expect(anonymised.tagName).toBe("A")
    expect(anonymised).toHaveAttribute(
      "href",
      expect.stringContaining("/admin/members/member-anon"),
    )

    // The id is still shown — it is what ties the row to the club's own audit
    // trail — but it is not a link, because there is nothing to link to.
    const hardDeleted = screen.getByText("member-gone")
    expect(hardDeleted.tagName).not.toBe("A")
  })

  it("offers every contact to Xero, and only reads on this page", async () => {
    renderPanel()
    await screen.findByText(/2 contacts to look at/i)

    const xeroLinks = screen.getAllByRole("link", { name: /open the contact in xero/i })
    expect(xeroLinks).toHaveLength(2)

    /*
      The controls are the section's own collapse toggle — which carries
      `aria-expanded` and navigates nothing — Refresh, which re-reads locally,
      and the Xero status check, which asks Xero a question and changes nothing
      in it. Anything else would be an action on a screen whose entire contract
      is that it takes none, and that is the kind of control that gets added
      later "for convenience".
    */
    const actionable = screen
      .getAllByRole("button")
      .filter((button) => !button.hasAttribute("aria-expanded"))
      .map((button) => button.textContent?.trim().toLowerCase())
    expect(actionable).toEqual(["refresh", "check these in xero"])
  })

  it("checks the listed contacts in Xero with a POST, and reports what came back", async () => {
    const fetchMock = renderPanel()
    await screen.findByText(/2 contacts to look at/i)

    fetchMock.mockImplementation(
      async (_url: string, _init?: RequestInit) =>
        ({
          ok: true,
          json: async () => ({
            review: { ...review, needsReview: 1, alreadyRetiredInXero: 2, rows: [review.rows[1]] },
            check: {
              checkedContacts: 2,
              observedContacts: 2,
              notFoundInXero: 0,
              retiredInXero: 1,
              checkedAt: "2026-06-25T00:00:00.000Z",
            },
          }),
        }) as unknown as Response,
    )

    fireEvent.click(screen.getByRole("button", { name: /check these in xero/i }))

    await screen.findByText(/Asked Xero about 2 contacts/i)
    expect(screen.getByText(/1 contact to look at/i)).toBeInTheDocument()

    const method = fetchMock.mock.calls.at(-1)?.[1]?.method
    expect(method).toBe("POST")
  })

  it("counts the contacts somebody has already dealt with in Xero", async () => {
    renderPanel()
    await screen.findByText(/1 more has already been archived or erased in Xero/i)
  })

  it("does not contradict itself when the work is finished", async () => {
    /*
      The state the archived count exists to celebrate, and the one the earlier
      revision handled worst: it printed "0 contacts to look at. 3 more are
      already archived" directly above "No erasure has left a Xero contact
      behind". Both sentences, at once, about the same three contacts.
    */
    renderPanel({
      review: { ...review, needsReview: 0, alreadyRetiredInXero: 3, rows: [] },
    })

    await screen.findByText(/Nothing left to look at/i)
    expect(
      screen.getByText(/All 3 contacts an erasure left behind have been archived or erased in Xero/i),
    ).toBeInTheDocument()
    expect(
      screen.queryByText(/No erasure in this application has left a Xero contact behind/i),
    ).toBeNull()
  })

  it("says plainly when nothing was left behind at all", async () => {
    renderPanel({
      review: { ...review, needsReview: 0, alreadyRetiredInXero: 0, rows: [] },
    })
    await screen.findByText(/No erasure in this application has left a Xero contact behind/i)
  })

  it("does not promise that Contact Sync will make the list shrink", async () => {
    /*
      It cannot. The bulk contact sync fetches changed contacts with archived
      ones excluded, and the erasure deleted the contact's cache row — so an
      archived contact is invisible to it for ever. Four places used to say
      otherwise.
    */
    renderPanel({
      review: { ...review, lastContactStatusCheckAt: null },
    })
    await waitFor(() =>
      expect(screen.getByText(/Contact Sync will not tell you/i)).toBeInTheDocument(),
    )
  })
})
