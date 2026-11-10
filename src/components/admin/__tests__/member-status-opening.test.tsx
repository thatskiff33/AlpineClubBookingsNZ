// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MemberDetailLink } from "@/components/admin/member-detail-link";
import { MemberLoginStageChip } from "@/components/admin/member-login-stage-chip";

afterEach(cleanup);

describe("shared member Access presentation", () => {
  it.each([
    [false, false, null, "No login", "bg-muted", "text-foreground"],
    [true, false, null, "Not invited", "bg-warning-3", "text-warning-11"],
    [true, false, "2999-01-01T00:00:00.000Z", "Invited", "bg-info-3", "text-info-11"],
    [true, true, null, "Can log in", "bg-success-3", "text-success-11"],
  ])(
    "renders %s/%s/%s as %s",
    (canLogin, setupComplete, inviteExpiry, label, background, foreground) => {
      render(
        <MemberLoginStageChip
          member={{
            canLogin,
            hasCompletedAccountSetup: setupComplete,
            pendingInviteExpiresAt: inviteExpiry,
          }}
        />,
      );
      expect(screen.getByText(label)).toHaveClass(background, foreground);
    },
  );
});

describe("finance-only E2E boundary", () => {
  it("uses FINANCE_USER and proves the Subscriptions surface is reachable", () => {
    const source = readFileSync(
      resolve(process.cwd(), "e2e/admin-roles.spec.ts"),
      "utf8",
    );
    const financeOnlyBlock = source.match(
      /test\("finance-only viewer[\s\S]*?(?=\ntest\("lodge role)/,
    )?.[0];

    expect(financeOnlyBlock).toBeDefined();
    expect(financeOnlyBlock).toContain("ROLE_PERSONAS.FINANCE_USER.email");
    expect(financeOnlyBlock).not.toContain("ROLE_PERSONAS.FINANCE_ADMIN.email");
    expect(financeOnlyBlock).toContain('page.goto("/admin/subscriptions")');
    expect(financeOnlyBlock).toContain('name: "Subscriptions"');
    expect(financeOnlyBlock).toContain('a[href^="/admin/members/"]');
    expect(financeOnlyBlock).toContain('name: "Incremental Sync"');
    expect(financeOnlyBlock).toContain('name: "Repair Stale Linked Members"');
    expect(financeOnlyBlock?.match(/toBeDisabled\(\)/g)).toHaveLength(2);
  });

  it("keeps both Xero sync actions on finance edit with a same-tick guard", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/app/(admin)/admin/finance/subscriptions/page.tsx"),
      "utf8",
    );
    const headerActions = source.match(
      /<AdminPageHeader[\s\S]*?\/>\s*\n\s*<SubscriptionBillingPanel/,
    )?.[0];

    expect(headerActions).toBeDefined();
    expect(headerActions?.match(/<ViewOnlyActionButton/g)).toHaveLength(2);
    expect(headerActions?.match(/canEdit=\{canEditFinance\}/g)).toHaveLength(2);
    expect(headerActions).not.toContain("describeReason={false}");
    expect(source).toContain(
      "if (canEditFinance !== true || syncActionInFlight.current) return;",
    );
    expect(source).toContain("syncActionInFlight.current = true;");
    expect(headerActions?.match(/disabled=\{syncActionPending\}/g)).toHaveLength(2);
  });
});

describe("permission-aware member opening", () => {
  it("renders a keyboard-focusable clean detail link for membership viewers", () => {
    render(
      <MemberDetailLink
        canViewMembership
        href="/admin/members/member-1?returnTo=%2Fadmin%2Fsubscriptions"
      >
        Summit, Alice
      </MemberDetailLink>,
    );

    const link = screen.getByRole("link", { name: "Summit, Alice" });
    expect(link).toHaveAttribute(
      "href",
      "/admin/members/member-1?returnTo=%2Fadmin%2Fsubscriptions",
    );
    expect(link).not.toHaveAttribute("href", expect.stringContaining("edit=true"));
    link.focus();
    expect(link).toHaveFocus();
  });

  it.each([false, undefined])(
    "renders plain text with no route when membership view is %s",
    (canViewMembership) => {
      render(
        <MemberDetailLink
          canViewMembership={canViewMembership}
          href="/admin/members/member-1"
        >
          Summit, Alice
        </MemberDetailLink>,
      );

      expect(screen.getByText("Summit, Alice")).toBeInTheDocument();
      expect(screen.queryByRole("link", { name: "Summit, Alice" })).toBeNull();
    },
  );
});
