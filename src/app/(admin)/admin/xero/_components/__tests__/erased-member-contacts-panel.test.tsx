// @vitest-environment jsdom

/**
 * The erased-member Xero contact panel (#3058). `INV-INT-024`.
 *
 * THREE properties are worth a browser-shaped test here, and the first is the
 * one the whole issue turns on.
 *
 * The panel must not read as a to-do list of things the club has to delete from
 * Xero. That is not a style preference: the settled contract is that this
 * application performs no Xero mutation as part of erasure and makes no claim
 * about what Xero should hold, so a screen implying otherwise would be the
 * feature shipping the exact instruction it was created to avoid giving. It is
 * asserted on the rendered text because that is what an officer reads.
 *
 * Second, a hard-deleted member must not be offered a member-page link. There
 * is no row left, so the link would be a 404 dressed as a destination — and the
 * two erasure kinds are otherwise indistinguishable on the screen.
 *
 * Third, nothing on the panel may be an action. A button that wrote would be a
 * far worse defect than a wrong sentence, and it is exactly the kind that gets
 * added later "for convenience".
 */

import "@testing-library/jest-dom/vitest"
import { render, screen, waitFor } from "@/lib/__tests__/support/club-time-render"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { ErasedMemberContactsPanel } from "../erased-member-contacts-panel"

const review = {
  needsReview: 2,
  alreadyArchivedInXero: 1,
  rows: [
    {
      memberId: "member-anon",
      xeroContactId: "xero-contact-anon",
      erasure: "ANONYMISED_BY_DELETION_REQUEST" as const,
      erasedAt: "2026-03-04T00:00:00.000Z",
      contactStatus: "ACTIVE" as const,
    },
    {
      memberId: "member-gone",
      xeroContactId: "xero-contact-gone",
      erasure: "HARD_DELETED" as const,
      erasedAt: "2026-04-05T00:00:00.000Z",
      contactStatus: "UNKNOWN" as const,
    },
  ],
  truncated: false,
  contactCacheLastRefreshedAt: "2026-06-01T00:00:00.000Z",
  contactCacheAgeHours: 2,
  contactCacheStale: false,
}

function renderPanel(body: unknown = { review }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => body }) as unknown as Response),
  )
  return render(
    <ErasedMemberContactsPanel
      open
      onToggle={() => {}}
      currentXeroPath="/admin/xero"
      shortCode="ABC123"
    />,
  )
}

describe("erased-member Xero contact panel (#3058)", () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it("says the club is not being asked to remove anything from Xero", async () => {
    renderPanel()
    await screen.findByText(/2 contacts to look at/i)

    expect(
      screen.getByText(/never edits, archives or deletes anything in/i),
    ).toBeInTheDocument()
    expect(
      screen.getByText(/not asking for anything to be removed/i),
    ).toBeInTheDocument()
    expect(
      screen.getByText(/decision for whoever\s+administers Xero/i),
    ).toBeInTheDocument()
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

  it("offers every contact to Xero and nothing to press here", async () => {
    renderPanel()
    await screen.findByText(/2 contacts to look at/i)

    const xeroLinks = screen.getAllByRole("link", { name: /open the contact in xero/i })
    expect(xeroLinks).toHaveLength(2)

    /*
      The only two controls are the section's own collapse toggle — which
      carries `aria-expanded` and navigates nothing — and Refresh, which
      re-reads. Anything else would be an action on a screen whose entire
      contract is that it takes none, and that is the kind of control that gets
      added later "for convenience".
    */
    const actionable = screen
      .getAllByRole("button")
      .filter((button) => !button.hasAttribute("aria-expanded"))
      .map((button) => button.textContent?.trim().toLowerCase())
    expect(actionable).toEqual(["refresh"])
  })

  it("counts the contacts somebody has already archived in Xero", async () => {
    renderPanel()
    await screen.findByText(/1 more is already archived in Xero/i)
  })

  it("says plainly when nothing was left behind", async () => {
    renderPanel({
      review: { ...review, needsReview: 0, alreadyArchivedInXero: 0, rows: [] },
    })
    await screen.findByText(/No erasure in this application has left a Xero contact behind/i)
  })

  it("warns that a stale cache can keep an archived contact listed", async () => {
    renderPanel({
      review: { ...review, contactCacheAgeHours: 400, contactCacheStale: true },
    })
    await waitFor(() =>
      expect(
        screen.getByText(/may still be listed/i),
      ).toBeInTheDocument(),
    )
  })
})
