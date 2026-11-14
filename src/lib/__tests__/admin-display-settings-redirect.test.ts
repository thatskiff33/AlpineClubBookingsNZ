import { describe, expect, it, vi } from "vitest";

import { adminHref } from "@/lib/admin-hubs";

// LTV-035 (#81): the per-lodge display settings card moved out of
// /admin/display/settings into the lodge configuration hub (/admin/lodges/[id])
// so it edits the lodge being viewed rather than the club default lodge. The old
// path must permanently redirect to the surviving Lobby Display surface (the
// Display Devices page) so existing links / bookmarks keep working. Mirrors the
// LTV-031 templates-redirect idiom that LTV-033 later removed. Fork issue #109
// moved the Devices page to /admin/display/devices (making /admin/display the
// Lobby Display hub), so the redirect now targets that path. C11 part 1 (#4808)
// moved both under /admin/lodge-ops: the stub redirects to Devices' adminHref,
// one hop in either switch state.

const { mockRedirect } = vi.hoisted(() => ({ mockRedirect: vi.fn() }));

vi.mock("next/navigation", () => ({
  redirect: (path: string) => mockRedirect(path),
}));

describe("/admin/display/settings redirect (LTV-035)", () => {
  it("redirects to Display Devices' adminHref", async () => {
    const { default: AdminDisplaySettingsRedirect } = await import(
      "@/app/(admin)/admin/lodge-ops/display/settings/page"
    );
    AdminDisplaySettingsRedirect();
    expect(mockRedirect).toHaveBeenCalledWith(adminHref("display-devices"));
  });
});
