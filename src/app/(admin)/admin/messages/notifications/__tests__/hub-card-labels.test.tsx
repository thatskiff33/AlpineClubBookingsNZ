// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import NotificationsHubPage from "@/app/(admin)/admin/messages/notifications/page";
import { adminHref, getAdminPage } from "@/lib/admin-hubs";

afterEach(cleanup);

/**
 * #4878: the Notifications & Email cards for Delivery Rules and Recipients
 * take their titles from the hub registry, the same names as the page headings.
 * A hand-written title would keep showing the old name after the registry moved.
 */
describe("Notifications & Email card titles (#4878)", () => {
  it("names Delivery Rules and Recipients from the registry", () => {
    render(<NotificationsHubPage />);

    expect(getAdminPage("notification-rules").label).toBe("Delivery Rules");
    expect(getAdminPage("notification-recipients").label).toBe("Recipients");

    for (const id of ["notification-rules", "notification-recipients"] as const) {
      const label = getAdminPage(id).label;
      const link = screen.getByRole("link", { name: new RegExp(label) });
      expect(link).toHaveAttribute("href", adminHref(id));
    }
  });
});
