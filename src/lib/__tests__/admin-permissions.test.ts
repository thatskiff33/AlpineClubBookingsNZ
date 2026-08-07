import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  bookingManagementAuthorizationRole,
  canViewAdminHref,
  canViewAdminHrefWithMatrix,
  financeAccessLevelFromMatrix,
  getAdminPermissionLevel,
  getAdminPermissionMatrix,
  getAdminRouteRequirement,
  hasAdminAreaAccess,
  hasAdminPortalAccess,
  hasFinanceManagerAccess,
  hasFinanceViewerAccess,
  sanitizeAdminPermissionMatrix,
  type AdminPermissionArea,
  type AdminPermissionLevel,
} from "@/lib/admin-permissions";
import {
  authorizationRoleFromAccessRoles,
  hasAdminAccess,
  type AppAccessRole,
} from "@/lib/access-roles";

const LODGE_ONLY_DEFINITION = {
  overviewLevel: "NONE",
  bookingsLevel: "NONE",
  membershipLevel: "NONE",
  financeLevel: "NONE",
  lodgeLevel: "EDIT",
  contentLevel: "NONE",
  supportLevel: "NONE",
} as const;

describe("admin permission bundles", () => {
  it("gives full admins edit access everywhere", () => {
    const matrix = getAdminPermissionMatrix({
      accessRoles: [{ role: "ADMIN" }],
      canLogin: true,
    });

    expect(Object.values(matrix).every((level) => level === "edit")).toBe(true);
    expect(hasAdminPortalAccess({ accessRoles: ["ADMIN"] })).toBe(true);
  });

  it("keeps read-only admin users at view access", () => {
    expect(
      getAdminPermissionLevel({ accessRoles: ["ADMIN_READONLY"] }, "bookings"),
    ).toBe("view");
    expect(
      hasAdminAreaAccess(
        { accessRoles: ["ADMIN_READONLY"] },
        { area: "bookings", level: "edit" },
      ),
    ).toBe(false);
  });

  it("merges bundled roles into a custom composed permission set", () => {
    const subject = {
      accessRoles: ["ADMIN_MEMBERSHIP", "ADMIN_CONTENT"],
      canLogin: true,
    };

    expect(getAdminPermissionLevel(subject, "membership")).toBe("edit");
    expect(getAdminPermissionLevel(subject, "content")).toBe("edit");
    expect(getAdminPermissionLevel(subject, "bookings")).toBe("view");
    expect(getAdminPermissionLevel(subject, "finance")).toBe("view");
  });

  it("keeps finance viewers out of the admin portal while allowing treasurers", () => {
    expect(hasAdminPortalAccess({ accessRoles: ["FINANCE_USER"] })).toBe(false);
    expect(hasAdminPortalAccess({ accessRoles: ["FINANCE_ADMIN"] })).toBe(true);
    expect(
      hasAdminAreaAccess(
        { accessRoles: ["FINANCE_ADMIN"] },
        { area: "finance", level: "edit" },
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Booking detail read-only admin-view guard (issue #1289).
//
// The admin bookings list/calendar is gated on bookings-area view, but the
// member-facing detail route src/app/(authenticated)/bookings/[id]/page.tsx
// previously gated on the narrow full-admin hasAdminAccess, so a Booking
// Officer / Read-only Admin reached the calendar but was redirected to
// "My Bookings". The guard now also admits bookings-area view holders
// read-only. This mirrors the exact redirect predicate from that page.
// ---------------------------------------------------------------------------
describe("booking detail read-only admin-view guard (issue #1289)", () => {
  // Mirrors the redirect guard in the booking detail page: a viewer loads the
  // detail when they can manage it, are a linked guest, or hold read-only
  // bookings-area admin access.
  const wouldRedirect = (viewer: {
    accessRoles: AppAccessRole[];
    isBookingOwner: boolean;
    isLinkedGuestViewer: boolean;
  }) => {
    const isAdmin = hasAdminAccess({ accessRoles: viewer.accessRoles });
    const canManageBooking = viewer.isBookingOwner || isAdmin;
    const canViewAsAdmin = hasAdminAreaAccess(
      { accessRoles: viewer.accessRoles },
      { area: "bookings", level: "view" },
    );
    return (
      !canManageBooking && !viewer.isLinkedGuestViewer && !canViewAsAdmin
    );
  };

  it("resolves the exact predicate the page evaluates for booking admins", () => {
    // Pins the precise call the page makes, so removing the canViewAsAdmin
    // wiring cannot pass on the mirror alone.
    expect(
      hasAdminAreaAccess(
        { accessRoles: ["ADMIN_BOOKINGS"] },
        { area: "bookings", level: "view" },
      ),
    ).toBe(true);
    expect(
      hasAdminAreaAccess(
        { accessRoles: ["ADMIN_READONLY"] },
        { area: "bookings", level: "view" },
      ),
    ).toBe(true);
    expect(
      hasAdminAreaAccess(
        { accessRoles: ["USER"] },
        { area: "bookings", level: "view" },
      ),
    ).toBe(false);
  });

  it("lets a Booking Officer (ADMIN_BOOKINGS) open a booking they do not own", () => {
    expect(
      wouldRedirect({
        accessRoles: ["ADMIN_BOOKINGS"],
        isBookingOwner: false,
        isLinkedGuestViewer: false,
      }),
    ).toBe(false);
  });

  it("lets a Read-only Admin (ADMIN_READONLY) open a booking they do not own", () => {
    expect(
      wouldRedirect({
        accessRoles: ["ADMIN_READONLY"],
        isBookingOwner: false,
        isLinkedGuestViewer: false,
      }),
    ).toBe(false);
  });

  it("still redirects an unrelated plain member away from a booking they do not own", () => {
    expect(
      wouldRedirect({
        accessRoles: ["USER"],
        isBookingOwner: false,
        isLinkedGuestViewer: false,
      }),
    ).toBe(true);
  });

  it("keeps the booking owner and full admin able to open the detail", () => {
    expect(
      wouldRedirect({
        accessRoles: ["USER"],
        isBookingOwner: true,
        isLinkedGuestViewer: false,
      }),
    ).toBe(false);
    expect(
      wouldRedirect({
        accessRoles: ["ADMIN"],
        isBookingOwner: false,
        isLinkedGuestViewer: false,
      }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Booking detail write-surface gates (issue #1313 + owner-approved option A2).
//
// A Booking Officer (the ADMIN_BOOKINGS bundle carries bookings:edit) may now
// operate BOTH:
//   1. the admin-tooling cluster (AdminBookingToolsCard: copy +
//      confirm-pending-guests; the admin requested-room editor) whose backing
//      routes live under /api/admin/bookings/* (bookings:edit); AND
//   2. the member-facing admin-operational controls — cancel, modify and
//      admin notes — whose /api/bookings/[id]/* routes were widened from
//      owner-or-Full-Admin to also accept bookings:edit (option A2). See
//      bookingManagementAuthorizationRole + the route gates. A fourth,
//      arrival-time, was in this set until #2621 retired the expected-arrival
//      -time entry and its route outright.
//
// Member-PERSONAL payment controls (save-card / complete / draft / additional
// payment) remain owner-only. These mirror the exact page gates AND pin the
// backing-route authz, so a widened button can never front a route that would
// 403 the officer.
// ---------------------------------------------------------------------------
describe("booking detail write-surface gates (issue #1313 + option A2)", () => {
  const identity = (accessRoles: AppAccessRole[], isBookingOwner: boolean) => {
    const subject = { accessRoles };
    const isAdmin = hasAdminAccess(subject);
    const canAdminEditBookings = hasAdminAreaAccess(subject, {
      area: "bookings",
      level: "edit",
    });
    const canManageBooking = isBookingOwner || isAdmin;
    return {
      // Admin-operational tooling cluster: Full Admin OR Booking Officer.
      canSeeAdminTools: isAdmin || canAdminEditBookings,
      // Member-personal payment section (save-card / complete / draft /
      // additional payment): owner only.
      showMemberPayment: isBookingOwner,
      // Member-facing admin-operational controls (cancel, admin notes, modify).
      // Option A2 widened their APIs, so the page predicates now admit a Booking
      // Officer alongside the owner and Full Admin. (#2621 removed a fourth,
      canCancel: canManageBooking || canAdminEditBookings,
      canModify: canManageBooking || canAdminEditBookings,
      // A non-owner Full Admin OR Booking Officer acts on-behalf of the member
      // (same suppress-notification / policy framing) for cancel + modify.
      actingOnBehalf: (isAdmin || canAdminEditBookings) && !isBookingOwner,
      // Owner second-person copy must not address a non-owner admin viewer.
      nonOwnerAdminViewer:
        !isBookingOwner &&
        hasAdminAreaAccess(subject, { area: "bookings", level: "view" }),
    };
  };

  it("grants the admin-tooling cluster to a non-owner Booking Officer", () => {
    expect(identity(["ADMIN_BOOKINGS"], false).canSeeAdminTools).toBe(true);
  });

  it("grants the admin-tooling cluster to a non-owner Full Admin", () => {
    expect(identity(["ADMIN"], false).canSeeAdminTools).toBe(true);
  });

  it("withholds the admin-tooling cluster from a read-only admin (view only)", () => {
    expect(identity(["ADMIN_READONLY"], false).canSeeAdminTools).toBe(false);
  });

  it("withholds the admin-tooling cluster from a plain member on their own booking", () => {
    expect(identity(["USER"], true).canSeeAdminTools).toBe(false);
  });

  it("shows the member payment section only to the owner, never a non-owner admin/officer", () => {
    expect(identity(["USER"], true).showMemberPayment).toBe(true);
    expect(identity(["ADMIN"], false).showMemberPayment).toBe(false);
    expect(identity(["ADMIN_BOOKINGS"], false).showMemberPayment).toBe(false);
  });

  it("grants the widened member-facing controls (cancel/modify) to a non-owner Booking Officer (option A2)", () => {
    const officer = identity(["ADMIN_BOOKINGS"], false);
    expect(officer.canCancel).toBe(true);
    expect(officer.canModify).toBe(true);
  });

  it("keeps the widened controls available to the booking owner and to a Full Admin", () => {
    for (const subject of [
      identity(["ADMIN"], false),
      identity(["USER"], true),
    ]) {
      expect(subject.canCancel).toBe(true);
      expect(subject.canModify).toBe(true);
    }
  });

  it("still withholds the widened controls from a read-only admin and a non-owner plain member", () => {
    for (const subject of [
      identity(["ADMIN_READONLY"], false),
      identity(["USER"], false),
    ]) {
      expect(subject.canCancel).toBe(false);
      expect(subject.canModify).toBe(false);
    }
  });

  it("treats a non-owner Full Admin OR Booking Officer as acting on-behalf, never the owner or a read-only admin", () => {
    expect(identity(["ADMIN"], false).actingOnBehalf).toBe(true);
    expect(identity(["ADMIN_BOOKINGS"], false).actingOnBehalf).toBe(true);
    expect(identity(["ADMIN_READONLY"], false).actingOnBehalf).toBe(false);
    // An officer on their OWN booking is a normal owner, not acting-on-behalf.
    expect(identity(["ADMIN_BOOKINGS"], true).actingOnBehalf).toBe(false);
    expect(identity(["USER"], true).actingOnBehalf).toBe(false);
  });

  it("treats every non-owner admin-type viewer as needing neutral copy (#1289)", () => {
    expect(identity(["ADMIN"], false).nonOwnerAdminViewer).toBe(true);
    expect(identity(["ADMIN_BOOKINGS"], false).nonOwnerAdminViewer).toBe(true);
    expect(identity(["ADMIN_READONLY"], false).nonOwnerAdminViewer).toBe(true);
    expect(identity(["USER"], true).nonOwnerAdminViewer).toBe(false);
    expect(identity(["USER"], false).nonOwnerAdminViewer).toBe(false);
  });

  // Button↔API consistency (the lynchpin): admin-tooling controls front
  // /api/admin/bookings/* (bookings:edit) — unchanged by A2.
  it("routes the admin-tooling buttons to bookings:edit APIs", () => {
    for (const path of [
      "/api/admin/bookings/BID/confirm-pending-guests",
      "/api/admin/bookings/BID/copy",
    ]) {
      expect(getAdminRouteRequirement(path, "POST")).toEqual({
        area: "bookings",
        level: "edit",
      });
    }
    expect(
      getAdminRouteRequirement("/api/admin/bookings/BID/requested-room", "PUT"),
    ).toEqual({ area: "bookings", level: "edit" });
    expect(
      getAdminRouteRequirement(
        "/api/admin/bookings/BID/requested-room",
        "DELETE",
      ),
    ).toEqual({ area: "bookings", level: "edit" });
  });

  it("confirms a Booking Officer satisfies the widened member-facing APIs' bookings:edit predicate", () => {
    // cancel/notes authorize on hasAdminAreaAccess(bookings:edit);
    // modify/quote/change-requests authorize via bookingManagementAuthorizationRole.
    expect(
      hasAdminAreaAccess(
        { accessRoles: ["ADMIN_BOOKINGS"] },
        { area: "bookings", level: "edit" },
      ),
    ).toBe(true);
    // A read-only admin (bookings:view, no edit) is NOT admitted.
    expect(
      hasAdminAreaAccess(
        { accessRoles: ["ADMIN_READONLY"] },
        { area: "bookings", level: "edit" },
      ),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// In-booking Bed allocation panel (#2252, epic #2245 B2).
//
// Every affordance on that card is a WRITE — assign, remove, confirm — so it
// sits behind the same admin-tooling cluster as the Admin tools card, not
// behind bookings:view. That is a deliberate asymmetry with the board, which a
// read-only admin can open read-only: it is one click away via the panel's own
// "Open on the board" link, and a card of disabled controls tells a read-only
// admin nothing the board does not tell them better.
//
// The predicate pin below is paired with a SOURCE pin on the render site,
// because the identity logic being right is worthless if the page renders the
// card outside it.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Outstanding additional payment panel visibility (#2350).
//
// The member-facing AdditionalPaymentCard is owner-only (#1303) because it
// carries the member's own card-entry controls. That left every other admin
// viewer with no sign that money was owing, which is the whole bug. The new
// panel is the read-only counterpart, so its gate is the READ gate — the same
// bookings-area view access that admits a Booking Officer or read-only admin to
// the detail page at all — while the re-send button inside it needs edit.
//
// The predicate pin is paired with a SOURCE pin on the render site, because the
// identity logic being right is worthless if the page renders the panel outside
// it — and in particular the owner must keep seeing their own card and NOT this.
// ---------------------------------------------------------------------------
describe("outstanding additional payment panel visibility (#2350)", () => {
  const bookingPageSource = () =>
    fs.readFileSync(
      path.join(
        process.cwd(),
        "src/app/(authenticated)/bookings/[id]/page.tsx",
      ),
      "utf8",
    );

  const canSeePanel = (accessRoles: AppAccessRole[], isBookingOwner = false) =>
    !isBookingOwner &&
    hasAdminAreaAccess({ accessRoles }, { area: "bookings", level: "view" });

  const canResend = (accessRoles: AppAccessRole[]) => {
    const subject = { accessRoles };
    return (
      hasAdminAccess(subject) ||
      hasAdminAreaAccess(subject, { area: "bookings", level: "edit" })
    );
  };

  it("shows the panel to every admin who can read bookings", () => {
    expect(canSeePanel(["ADMIN"])).toBe(true);
    expect(canSeePanel(["ADMIN_BOOKINGS"])).toBe(true);
    expect(canSeePanel(["ADMIN_READONLY"])).toBe(true);
  });

  it("withholds it from a plain member and from the booking's own owner", () => {
    expect(canSeePanel(["USER"])).toBe(false);
    // An admin looking at their OWN booking keeps the member card (#1303) and
    // does not get a second, admin-framed copy of the same fact.
    expect(canSeePanel(["ADMIN"], true)).toBe(false);
  });

  it("withholds it from an admin with no bookings scope at all", () => {
    // ADMIN_MEMBERSHIP and FINANCE_ADMIN both carry bookings:view, so they DO
    // reach the detail page and DO see this panel — reading that money is owing
    // is exactly what a membership or finance officer is entitled to. Only a
    // scope with no bookings access is excluded.
    expect(canSeePanel(["ADMIN_CONTENT"])).toBe(false);
    expect(canSeePanel(["ADMIN_MEMBERSHIP"])).toBe(true);
    expect(canSeePanel(["FINANCE_ADMIN"])).toBe(true);
  });

  it("offers the re-send only to admins who may write bookings", () => {
    expect(canResend(["ADMIN"])).toBe(true);
    expect(canResend(["ADMIN_BOOKINGS"])).toBe(true);
    expect(canResend(["ADMIN_READONLY"])).toBe(false);
    expect(canResend(["ADMIN_MEMBERSHIP"])).toBe(false);
    expect(canResend(["FINANCE_ADMIN"])).toBe(false);
    expect(canResend(["USER"])).toBe(false);
  });

  it("renders the panel only behind the non-owner admin-viewer gate", () => {
    const source = bookingPageSource();

    expect(source).toMatch(
      /\{nonOwnerAdminViewer && !isDeleted && booking\.payment \? \(\s*<BookingAdditionalPaymentPanel/,
    );
    // Exactly one render site, so a second ungated copy cannot creep in.
    expect(source.match(/<BookingAdditionalPaymentPanel/g)).toHaveLength(1);
    // …and the re-send is handed the edit gate, never the view gate.
    expect(source).toMatch(/canResend=\{canSeeAdminTools\}/);
  });

  /*
    The member's own card stays owner-only (#1303). #2350 round 2 added ONE
    clause to that condition and nothing else: the booking's lifecycle, because
    cancelling leaves the delta columns untouched and the card was still
    offering a cancelled booking's owner a payment form (see
    src/components/__tests__/additional-payment-card-gate.test.ts). The owner
    gate itself is unchanged, which is what this pin is for.
  */
  it("leaves the member's own owner-only card exactly where it was (#1303)", () => {
    const source = bookingPageSource();

    expect(source).toMatch(
      /booking\.payment &&\s*isBookingOwner &&\s*!isDeleted &&\s*isAdditionalPayableBookingStatus\(booking\.status\) &&\s*booking\.payment\.additionalAmountCents > 0 &&\s*booking\.payment\.additionalPaymentStatus !== "SUCCEEDED" && \(\s*<AdditionalPaymentCard/,
    );
  });
});

describe("in-booking bed allocation panel visibility (#2252)", () => {
  const bookingPageSource = () =>
    fs.readFileSync(
      path.join(
        process.cwd(),
        "src/app/(authenticated)/bookings/[id]/page.tsx",
      ),
      "utf8",
    );

  const canSeePanel = (accessRoles: AppAccessRole[]) => {
    const subject = { accessRoles };
    return (
      hasAdminAccess(subject) ||
      hasAdminAreaAccess(subject, { area: "bookings", level: "edit" })
    );
  };

  it("shows the panel to a Full Admin and to a Booking Officer", () => {
    expect(canSeePanel(["ADMIN"])).toBe(true);
    expect(canSeePanel(["ADMIN_BOOKINGS"])).toBe(true);
  });

  it("withholds it from a read-only admin, who gets the board instead", () => {
    expect(canSeePanel(["ADMIN_READONLY"])).toBe(false);
  });

  it("withholds it from a plain member, including the booking's own owner", () => {
    // Ownership grants nothing here: the panel is admin tooling, and the member
    // never receives the component or the allocation data behind it.
    expect(canSeePanel(["USER"])).toBe(false);
  });

  it("withholds it from an admin scoped away from bookings", () => {
    expect(canSeePanel(["ADMIN_MEMBERSHIP"])).toBe(false);
    expect(canSeePanel(["ADMIN_CONTENT"])).toBe(false);
    expect(canSeePanel(["FINANCE_ADMIN"])).toBe(false);
  });

  it("renders the panel only behind canSeeAdminTools AND the bedAllocation module flag", () => {
    const source = bookingPageSource();

    // ONE named gate, defined as exactly that conjunction: the routes 404 when
    // the module is off, and the member-invisibility half is this gate.
    expect(source).toMatch(
      /const showBedAllocationPanel =\s*canSeeAdminTools && modules\.bedAllocation;/,
    );
    // The render site is that gate and nothing looser…
    expect(source).toMatch(
      /\{showBedAllocationPanel && \(\s*<BookingBedAllocationPanel/,
    );
    // …and there is exactly one render site, so a second, ungated copy cannot
    // creep in below the first.
    expect(source.match(/<BookingBedAllocationPanel/g)).toHaveLength(1);
  });

  it("builds the section rail without the admin-only entry rather than pruning it after mount", () => {
    // #2252 review: SectionNav prunes absent anchors in an EFFECT, so a member's
    // server-rendered rail really did contain a "Bed Allocation" link until
    // hydration removed it. The page knows both halves of the gate server-side,
    // so the entry is filtered out before it is ever sent.
    const source = bookingPageSource();

    expect(source).toMatch(
      /sections=\{BOOKING_SECTIONS\.filter\(\s*\(section\) =>\s*section\.id !== "bed-allocation" \|\| showBedAllocationPanel,\s*\)\}/,
    );
  });

  it("renders the bed allocation card in the position BOOKING_SECTIONS declares for it", () => {
    /*
     * #2252 review: the card was rendering above every other anchored section
     * while BOOKING_SECTIONS listed it sixth. SectionNav is presentation-only —
     * it prunes candidates but never reorders — so a rail order that disagrees
     * with the render order is simply a lie to the reader.
     *
     * This pins the general rule, not just the one anchor: every id declared in
     * BOOKING_SECTIONS must appear in the page's markup in the declared order.
     */
    const source = bookingPageSource();

    const declared = Array.from(
      source
        .slice(
          source.indexOf("const BOOKING_SECTIONS"),
          source.indexOf("export default async function BookingDetailPage"),
        )
        .matchAll(/\{ id: "([^"]+)", label:/g),
    ).map((match) => match[1]);
    expect(declared.length).toBeGreaterThan(5);
    expect(declared).toContain("bed-allocation");

    // Where each declared anchor is actually rendered. `id="details"` etc. are
    // the section/card anchors; the panel owns its own id inside the component,
    // so its render site is located by the component tag.
    const renderedAt = declared.map((id) => {
      const index =
        id === "bed-allocation"
          ? source.indexOf("<BookingBedAllocationPanel")
          : source.indexOf(`id="${id}"`);
      expect(index, `${id} is rendered somewhere`).toBeGreaterThan(-1);
      return { id, index };
    });

    expect(renderedAt.map((entry) => entry.id)).toEqual(
      [...renderedAt].sort((left, right) => left.index - right.index).map(
        (entry) => entry.id,
      ),
    );
  });

  it("keys the panel's write controls off the same permission its APIs demand", () => {
    // Assign/confirm remain bookings:edit. Removal's preview is an explicit
    // bookings:view read; applying that reviewed preview is bookings:edit — the
    // same area/level the panel's useAdminAreaEditAccess("bookings") gate asks
    // for, so no write button is rendered enabled that the route would refuse.
    for (const path of [
      "/api/admin/bed-allocation/approve",
      "/api/admin/bed-allocation/allocations/range",
    ]) {
      expect(getAdminRouteRequirement(path, "POST")).toEqual({
        area: "bookings",
        level: "edit",
      });
    }
    // This source-based path helper reports the strongest requirement in a
    // mixed-method file. The removal route's dedicated handler tests pin POST
    // to view; this assertion pins its PUT/write boundary here.
    expect(
      getAdminRouteRequirement(
        "/api/admin/bed-allocation/allocations/removal",
        "PUT",
      ),
    ).toEqual({ area: "bookings", level: "edit" });
  });
});

// ---------------------------------------------------------------------------
// bookingManagementAuthorizationRole (issue #1313 option A2): the single legacy
// authorization Role the widened modify / modify-quote / change-requests paths
// key their admin-on-behalf relaxations off. A Booking Officer maps onto the
// existing ADMIN path; every other actor keeps their legacy authorization role.
// ---------------------------------------------------------------------------
describe("bookingManagementAuthorizationRole (issue #1313 option A2)", () => {
  it("maps a Booking Officer (bookings:edit) onto the admin-on-behalf ADMIN path", () => {
    expect(
      bookingManagementAuthorizationRole({ accessRoles: ["ADMIN_BOOKINGS"] }),
    ).toBe("ADMIN");
  });

  it("leaves a Full Admin at ADMIN (byte-identical to authorizationRoleFromAccessRoles)", () => {
    expect(
      bookingManagementAuthorizationRole({ accessRoles: ["ADMIN"] }),
    ).toBe("ADMIN");
    expect(
      bookingManagementAuthorizationRole({ accessRoles: ["ADMIN"] }),
    ).toBe(authorizationRoleFromAccessRoles({ accessRoles: ["ADMIN"] }));
  });

  it("keeps a plain member at USER", () => {
    expect(
      bookingManagementAuthorizationRole({ accessRoles: ["USER"] }),
    ).toBe("USER");
  });

  it("keeps a read-only admin (bookings:view, no edit) at USER", () => {
    expect(
      bookingManagementAuthorizationRole({ accessRoles: ["ADMIN_READONLY"] }),
    ).toBe("USER");
  });

  it("keeps a scoped admin without bookings:edit (Membership Officer) at USER", () => {
    expect(
      bookingManagementAuthorizationRole({ accessRoles: ["ADMIN_MEMBERSHIP"] }),
    ).toBe("USER");
  });

  it("preserves a non-admin legacy role (LODGE) rather than forcing ADMIN", () => {
    expect(
      bookingManagementAuthorizationRole({ accessRoles: ["LODGE"] }),
    ).toBe("LODGE");
  });

  it("clears to USER when the account cannot log in", () => {
    expect(
      bookingManagementAuthorizationRole({
        accessRoles: ["ADMIN_BOOKINGS"],
        canLogin: false,
      }),
    ).toBe("USER");
  });
});

describe("admin route requirements", () => {
  it("maps admin pages to view-level area access", () => {
    expect(getAdminRouteRequirement("/admin/members/123", "GET")).toEqual({
      area: "membership",
      level: "view",
    });
    expect(getAdminRouteRequirement("/admin/setup/finance", "GET")).toEqual({
      area: "finance",
      level: "view",
    });
    expect(getAdminRouteRequirement("/admin/setup", "GET")).toEqual({
      area: "support",
      level: "view",
    });
    expect(
      canViewAdminHref({ accessRoles: ["ADMIN_CONTENT"] }, "/admin/page-content"),
    ).toBe(true);
    expect(
      canViewAdminHref({ accessRoles: ["ADMIN_CONTENT"] }, "/admin/members"),
    ).toBe(false);
  });

  it("maps mutating admin API methods to edit access", () => {
    expect(getAdminRouteRequirement("/api/admin/page-content", "POST")).toEqual({
      area: "content",
      level: "edit",
    });
    expect(
      getAdminRouteRequirement("/api/admin/members/member-1/xero-link", "POST"),
    ).toEqual({
      area: "finance",
      level: "edit",
    });
  });

  it("keeps real admin APIs in their intended areas instead of overview fallback", () => {
    expect(
      getAdminRouteRequirement(
        "/api/admin/membership-cancellation-requests",
        "GET",
      ),
    ).toEqual({
      area: "membership",
      level: "view",
    });
    expect(
      getAdminRouteRequirement("/api/admin/induction-templates", "POST"),
    ).toEqual({
      area: "membership",
      level: "edit",
    });
    expect(
      getAdminRouteRequirement("/api/admin/email-failures/failure-1/review", "POST"),
    ).toEqual({
      area: "support",
      level: "edit",
    });
  });

  it("treats state-changing provider GET endpoints as edit access", () => {
    expect(getAdminRouteRequirement("/api/admin/xero/callback", "GET")).toEqual({
      area: "finance",
      level: "edit",
    });
  });

  it("maps the bookings-scoped on-behalf family pickers to the bookings area (#1376)", () => {
    // Both new on-behalf pickers live under /api/admin/bookings so the route
    // map keeps them in the bookings area — NOT membership. If either were
    // accidentally placed under /api/admin/members it would silently inherit
    // membership:view (the exact mispricing bug #1376 fixes).
    expect(
      getAdminRouteRequirement(
        "/api/admin/bookings/booking-1/eligible-family",
        "GET",
      ),
    ).toEqual({ area: "bookings", level: "view" });
    expect(
      getAdminRouteRequirement("/api/admin/bookings/eligible-family", "GET"),
    ).toEqual({ area: "bookings", level: "view" });
  });

  it("lets a bookings:edit actor without membership:view reach the on-behalf pickers (#1376)", () => {
    // The seeded Booking Officer holds bookings:edit; a club may customise the
    // role to drop membership:view. The endpoints demand bookings:edit
    // explicitly, so this actor passes while a membership-only viewer does not.
    const officerNoMembershipView = {
      accessRoles: [] as AppAccessRole[],
      adminPermissionMatrix: {
        overview: "view",
        bookings: "edit",
        membership: "none",
        finance: "none",
        lodge: "none",
        content: "none",
        support: "none",
      },
    };
    expect(
      hasAdminAreaAccess(officerNoMembershipView, {
        area: "bookings",
        level: "edit",
      }),
    ).toBe(true);

    const membershipViewerNoBookings = {
      accessRoles: [] as AppAccessRole[],
      adminPermissionMatrix: {
        overview: "view",
        bookings: "none",
        membership: "edit",
        finance: "none",
        lodge: "none",
        content: "none",
        support: "none",
      },
    };
    expect(
      hasAdminAreaAccess(membershipViewerNoBookings, {
        area: "bookings",
        level: "edit",
      }),
    ).toBe(false);

    // A bookings VIEWER (not editor) is also rejected — the explicit edit gate
    // is enforced, not merely bookings-area presence.
    const bookingsViewerOnly = {
      accessRoles: [] as AppAccessRole[],
      adminPermissionMatrix: {
        overview: "view",
        bookings: "view",
        membership: "none",
        finance: "none",
        lodge: "none",
        content: "none",
        support: "none",
      },
    };
    expect(
      hasAdminAreaAccess(bookingsViewerOnly, {
        area: "bookings",
        level: "edit",
      }),
    ).toBe(false);
  });
});

describe("definition-backed access roles", () => {
  it("prefers a joined definition over the legacy bundle for the same enum role", () => {
    // Club edited Booking Officer down to bookings: view.
    const matrix = getAdminPermissionMatrix({
      accessRoles: [
        {
          role: "ADMIN_BOOKINGS",
          roleDefinitionId: "ardef_admin_bookings",
          roleDefinition: {
            overviewLevel: "VIEW",
            bookingsLevel: "VIEW",
            membershipLevel: "NONE",
            financeLevel: "NONE",
            lodgeLevel: "NONE",
            contentLevel: "NONE",
            supportLevel: "NONE",
          },
        },
      ],
      canLogin: true,
    });
    expect(matrix.bookings).toBe("view");
    expect(matrix.lodge).toBe("none");
  });

  it("resolves custom definition-backed rows with no enum value", () => {
    const subject = {
      accessRoles: [
        {
          role: null,
          roleDefinitionId: "ardef_custom",
          roleDefinition: LODGE_ONLY_DEFINITION,
        },
      ],
      canLogin: true,
    };
    expect(getAdminPermissionLevel(subject, "lodge")).toBe("edit");
    expect(getAdminPermissionLevel(subject, "bookings")).toBe("none");
  });

  it("fails closed for custom rows selected without their definition", () => {
    const matrix = getAdminPermissionMatrix({
      accessRoles: [{ role: null, roleDefinitionId: "ardef_custom" }],
      canLogin: true,
    });
    expect(Object.values(matrix).every((level) => level === "none")).toBe(
      true,
    );
  });

  it("always resolves ADMIN from the hardcoded bundle, never a definition", () => {
    const matrix = getAdminPermissionMatrix({
      accessRoles: [
        {
          role: "ADMIN",
          roleDefinitionId: "ardef_rogue",
          roleDefinition: LODGE_ONLY_DEFINITION,
        },
      ],
      canLogin: true,
    });
    expect(Object.values(matrix).every((level) => level === "edit")).toBe(
      true,
    );
  });

  it("keeps the legacy bundle as fallback for bare enum rows", () => {
    expect(
      getAdminPermissionLevel({ accessRoles: ["ADMIN_BOOKINGS"] }, "bookings"),
    ).toBe("edit");
    expect(
      getAdminPermissionLevel({ accessRoles: ["FINANCE_USER"] }, "finance"),
    ).toBe("view");
  });

  it("supports matrix-based nav checks for client components", () => {
    const matrix = getAdminPermissionMatrix({
      accessRoles: ["ADMIN_CONTENT"],
      canLogin: true,
    });
    expect(canViewAdminHrefWithMatrix(matrix, "/admin/page-content")).toBe(
      true,
    );
    expect(canViewAdminHrefWithMatrix(matrix, "/admin/payments")).toBe(false);

    const financeMatrix = getAdminPermissionMatrix({
      accessRoles: ["FINANCE_USER"],
      canLogin: true,
    });
    expect(canViewAdminHrefWithMatrix(financeMatrix, "/admin/setup/finance")).toBe(
      true,
    );
    expect(canViewAdminHrefWithMatrix(financeMatrix, "/admin/setup")).toBe(false);
  });
});

describe("matrix-derived finance access", () => {
  it("treats finance edit as manager and finance view as viewer", () => {
    expect(hasFinanceManagerAccess({ accessRoles: ["FINANCE_ADMIN"] })).toBe(
      true,
    );
    expect(hasFinanceViewerAccess({ accessRoles: ["FINANCE_USER"] })).toBe(
      true,
    );
    expect(hasFinanceManagerAccess({ accessRoles: ["FINANCE_USER"] })).toBe(
      false,
    );
    expect(hasFinanceViewerAccess({ accessRoles: ["USER"] })).toBe(false);
  });

  it("gives Full Admin manager access and scoped admins viewer access via their matrices", () => {
    // Intentional widening vs the legacy enum-keyed helpers.
    expect(hasFinanceManagerAccess({ accessRoles: ["ADMIN"] })).toBe(true);
    expect(hasFinanceViewerAccess({ accessRoles: ["ADMIN_READONLY"] })).toBe(
      true,
    );
    expect(hasFinanceViewerAccess({ accessRoles: ["ADMIN_BOOKINGS"] })).toBe(
      true,
    );
    expect(hasFinanceViewerAccess({ accessRoles: ["ADMIN_CONTENT"] })).toBe(
      false,
    );
  });

  it("derives finance access from custom definitions", () => {
    const financeViewRole = {
      accessRoles: [
        {
          role: null,
          roleDefinitionId: "ardef_custom_finance",
          roleDefinition: {
            ...LODGE_ONLY_DEFINITION,
            lodgeLevel: "NONE",
            financeLevel: "VIEW",
          },
        },
      ],
      canLogin: true,
    } as const;
    expect(hasFinanceViewerAccess(financeViewRole)).toBe(true);
    expect(hasFinanceManagerAccess(financeViewRole)).toBe(false);
  });

  it("maps matrices to the legacy financeAccessLevel compatibility values", () => {
    expect(
      financeAccessLevelFromMatrix(
        getAdminPermissionMatrix({ accessRoles: ["FINANCE_ADMIN"] }),
      ),
    ).toBe("MANAGER");
    expect(
      financeAccessLevelFromMatrix(
        getAdminPermissionMatrix({ accessRoles: ["ADMIN_MEMBERSHIP"] }),
      ),
    ).toBe("VIEWER");
    expect(
      financeAccessLevelFromMatrix(
        getAdminPermissionMatrix({ accessRoles: ["USER"] }),
      ),
    ).toBe("NONE");
  });
});

// ---------------------------------------------------------------------------
// Authorization matrix over every real admin API route (issue #1132).
//
// Enumerates src/app/api/admin/**/route.ts from the filesystem and, for every
// exported HTTP method, resolves the effective admin requirement with the real
// getAdminRouteRequirement machinery (no route passes an explicit `permission`
// option today, so the inferred requirement IS the production requirement).
// Each identity class is then checked against hasAdminAreaAccess:
//   - anonymous / no-roles and plain members must always be denied;
//   - every role bundle must match the hand-written truth table below.
// The truth table intentionally duplicates ADMIN_ROLE_BUNDLES: a change to a
// bundle (or to the route→area prefix map) must show up here as a reviewable
// test diff instead of silently widening access.
// ---------------------------------------------------------------------------

const ADMIN_API_DIR = path.join(process.cwd(), "src/app/api/admin");

function listAdminRouteFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return listAdminRouteFiles(entryPath);
    return entry.name === "route.ts" ? [entryPath] : [];
  });
}

/** src/app/api/admin/foo/[id]/route.ts -> /api/admin/foo/dynamic-id */
function routeFileToPathname(filePath: string) {
  const relative = path
    .relative(path.join(process.cwd(), "src/app"), path.dirname(filePath))
    .split(path.sep)
    .join("/");
  return `/${relative}`.replace(/\[[^\]]+\]/g, "dynamic-id");
}

function exportedHttpMethods(filePath: string): string[] {
  const contents = fs.readFileSync(filePath, "utf8");
  return [
    ...contents.matchAll(
      /export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)\s*\(/g,
    ),
  ].map((match) => match[1]);
}

// Hand-written truth table: what each role bundle may do per admin area.
// Mirrors ADMIN_ROLE_BUNDLES in src/lib/admin-permissions.ts on purpose.
const EXPECTED_BUNDLE_LEVELS: Record<
  string,
  Partial<Record<AdminPermissionArea, AdminPermissionLevel>>
> = {
  ADMIN: {
    overview: "edit",
    bookings: "edit",
    membership: "edit",
    finance: "edit",
    lodge: "edit",
    content: "edit",
    support: "edit",
  },
  ADMIN_READONLY: {
    overview: "view",
    bookings: "view",
    membership: "view",
    finance: "view",
    lodge: "view",
    content: "view",
    support: "view",
  },
  ADMIN_BOOKINGS: {
    overview: "view",
    bookings: "edit",
    membership: "view",
    finance: "view",
    lodge: "edit",
    support: "view",
  },
  ADMIN_MEMBERSHIP: {
    overview: "view",
    bookings: "view",
    membership: "edit",
    finance: "view",
    support: "view",
  },
  ADMIN_CONTENT: {
    overview: "view",
    content: "edit",
  },
  // Finance access is matrix-derived: the seeded Finance Viewer definition
  // (and its fallback bundle) grants read-only finance admin access.
  FINANCE_USER: {
    finance: "view",
  },
  FINANCE_ADMIN: {
    overview: "view",
    bookings: "view",
    membership: "view",
    finance: "edit",
    support: "view",
  },
};

// Roles that must never pass an admin API requirement, plus the anonymous /
// empty-role identities. LODGE uses the lodge kiosk surface; ORG has no
// admin surface at all. FINANCE_USER is checked via the bundle truth table
// instead: its matrix-derived finance view allows read-only finance-area
// access.
const ALWAYS_DENIED_IDENTITIES: Array<{
  label: string;
  accessRoles: AppAccessRole[];
}> = [
  { label: "anonymous / no roles", accessRoles: [] },
  { label: "plain member", accessRoles: ["USER"] },
  { label: "lodge kiosk", accessRoles: ["LODGE"] },
  { label: "organisation", accessRoles: ["ORG"] },
];

const LEVEL_RANK: Record<AdminPermissionLevel, number> = {
  none: 0,
  view: 1,
  edit: 2,
};

// Admin API routes allowed to resolve to the `/api/admin` overview catch-all.
// Overview view access is granted to EVERY scoped admin bundle, so an
// unmapped route silently becomes readable by all of them. Keep this list
// empty-by-default: a new admin route must be added to a specific area prefix
// in ROUTE_AREA_PREFIXES (src/lib/admin-permissions.ts) or consciously listed
// here with a justification.
const OVERVIEW_CATCH_ALL_ALLOWLIST: string[] = [
  // Cross-area navigation badge counts for the admin shell; genuinely
  // belongs to "overview" (every scoped admin sees the nav).
  "/api/admin/pending-counts",
];

describe("admin API authorization matrix (issue #1132)", () => {
  const routeFiles = listAdminRouteFiles(ADMIN_API_DIR).sort();
  const routeMethodPairs = routeFiles.flatMap((filePath) => {
    const pathname = routeFileToPathname(filePath);
    return exportedHttpMethods(filePath).map((method) => ({
      pathname,
      method,
    }));
  });

  it("finds a plausible number of admin routes and methods", () => {
    // Guard the enumeration itself: if the walker breaks and returns nothing,
    // every other assertion would pass vacuously.
    expect(routeFiles.length).toBeGreaterThan(150);
    expect(routeMethodPairs.length).toBeGreaterThan(routeFiles.length);
  });

  it("resolves every admin API route and method to an admin requirement", () => {
    const unresolved = routeMethodPairs.filter(
      ({ pathname, method }) =>
        getAdminRouteRequirement(pathname, method) === null,
    );

    expect(unresolved).toEqual([]);
  });

  it("keeps the overview catch-all allowlist exact", () => {
    const overviewRoutes = [
      ...new Set(
        routeMethodPairs
          .filter(
            ({ pathname, method }) =>
              getAdminRouteRequirement(pathname, method)?.area === "overview",
          )
          .map(({ pathname }) => pathname),
      ),
    ].sort();

    expect(overviewRoutes).toEqual([...OVERVIEW_CATCH_ALL_ALLOWLIST].sort());
  });

  it("denies anonymous, plain member, lodge, and org identities on every admin route", () => {
    const violations = routeMethodPairs.flatMap(({ pathname, method }) => {
      const requirement = getAdminRouteRequirement(pathname, method);
      if (!requirement) return [];

      return ALWAYS_DENIED_IDENTITIES.flatMap(({ label, accessRoles }) =>
        hasAdminAreaAccess({ accessRoles }, requirement)
          ? [`${pathname}#${method}: unexpectedly allows ${label}`]
          : [],
      );
    });

    expect(violations).toEqual([]);
  });

  it("matches the hand-written role-bundle truth table on every admin route", () => {
    const violations = routeMethodPairs.flatMap(({ pathname, method }) => {
      const requirement = getAdminRouteRequirement(pathname, method);
      if (!requirement) return [];

      return Object.entries(EXPECTED_BUNDLE_LEVELS).flatMap(
        ([role, areaLevels]) => {
          const grantedLevel = areaLevels[requirement.area] ?? "none";
          const expected =
            LEVEL_RANK[grantedLevel] >= LEVEL_RANK[requirement.level];
          const actual = hasAdminAreaAccess(
            { accessRoles: [role as AppAccessRole] },
            requirement,
          );

          return actual === expected
            ? []
            : [
                `${pathname}#${method}: ${role} expected ${
                  expected ? "allow" : "deny"
                } for ${requirement.area}:${requirement.level} but machinery ${
                  actual ? "allowed" : "denied"
                }`,
              ];
        },
      );
    });

    expect(violations).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
// #1367 (F14): session.user carries an embedded adminPermissionMatrix computed
// from the DB-joined member, because its accessRoles claim is enum-only and
// drops definition-backed custom roles. The embedded matrix is authoritative.
// -----------------------------------------------------------------------------
describe("embedded session permission matrix (#1367)", () => {
  const ALL_NONE = {
    overview: "none",
    bookings: "none",
    membership: "none",
    finance: "none",
    lodge: "none",
    content: "none",
    support: "none",
  } as const;

  // A session.user whose ONLY role is a custom definition granting
  // bookings:edit — the enum claim is empty, the matrix carries the grant.
  const customOfficerSessionUser = {
    accessRoles: [] as AppAccessRole[],
    adminPermissionMatrix: { ...ALL_NONE, bookings: "edit" },
  };

  it("grants a custom-role session user the same gates as a seeded Booking Officer", () => {
    const seededOfficer = { accessRoles: ["ADMIN_BOOKINGS" as AppAccessRole] };

    for (const requirement of [
      { area: "bookings", level: "view" },
      { area: "bookings", level: "edit" },
    ] as const) {
      expect(hasAdminAreaAccess(customOfficerSessionUser, requirement)).toBe(
        hasAdminAreaAccess(seededOfficer, requirement),
      );
      expect(hasAdminAreaAccess(customOfficerSessionUser, requirement)).toBe(
        true,
      );
    }

    // The cancel service's on-behalf role mapping (#1313 option A2) follows.
    expect(bookingManagementAuthorizationRole(customOfficerSessionUser)).toBe(
      bookingManagementAuthorizationRole({
        accessRoles: ["ADMIN_BOOKINGS"],
      }),
    );
    expect(bookingManagementAuthorizationRole(customOfficerSessionUser)).toBe(
      "ADMIN",
    );

    // Portal access opens; Full-Admin separation-of-duties gates stay shut.
    expect(hasAdminPortalAccess(customOfficerSessionUser)).toBe(true);
    expect(hasAdminAccess(customOfficerSessionUser)).toBe(false);
    // No leakage into areas the definition does not grant.
    expect(
      hasAdminAreaAccess(customOfficerSessionUser, {
        area: "membership",
        level: "view",
      }),
    ).toBe(false);
  });

  it("treats the embedded matrix as authoritative over enum bundles (a narrowed seeded role must not widen back)", () => {
    // The club edited the seeded Booking Officer definition down to view-only;
    // the jwt refresh embedded that narrowed matrix. The enum claim alone
    // would re-derive the WIDER legacy bundle — it must not win.
    const narrowedOfficer = {
      accessRoles: ["ADMIN_BOOKINGS" as AppAccessRole],
      adminPermissionMatrix: { ...ALL_NONE, bookings: "view" },
    };

    expect(
      hasAdminAreaAccess(narrowedOfficer, { area: "bookings", level: "view" }),
    ).toBe(true);
    expect(
      hasAdminAreaAccess(narrowedOfficer, { area: "bookings", level: "edit" }),
    ).toBe(false);
  });

  it("falls back to role derivation when the embedded value is not a matrix at all", () => {
    expect(
      hasAdminAreaAccess(
        {
          accessRoles: ["ADMIN_BOOKINGS" as AppAccessRole],
          adminPermissionMatrix: "garbage",
        },
        { area: "bookings", level: "edit" },
      ),
    ).toBe(true);
  });

  it("keeps canLogin=false ahead of the embedded matrix (cleared access stays cleared)", () => {
    expect(
      getAdminPermissionMatrix({
        accessRoles: [],
        canLogin: false,
        adminPermissionMatrix: { ...ALL_NONE, bookings: "edit" },
      }),
    ).toEqual(ALL_NONE);
  });

  it("sanitizes per area, failing closed on malformed or missing levels", () => {
    // Non-objects are rejected outright.
    expect(sanitizeAdminPermissionMatrix(null)).toBeNull();
    expect(sanitizeAdminPermissionMatrix(undefined)).toBeNull();
    expect(sanitizeAdminPermissionMatrix("edit")).toBeNull();
    expect(sanitizeAdminPermissionMatrix(["edit"])).toBeNull();

    // Partial/malformed objects keep valid areas and zero the rest, so a
    // matrix minted before a new area existed denies that area instead of
    // being discarded (which would fall back to the wider bundle derivation).
    expect(
      sanitizeAdminPermissionMatrix({
        bookings: "edit",
        finance: "ADMIN",
        lodge: 3,
      }),
    ).toEqual({ ...ALL_NONE, bookings: "edit" });
  });
});
