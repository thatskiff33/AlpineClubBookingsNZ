// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor } from "@/lib/__tests__/support/club-time-render";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ImageManagerClient } from "@/app/(admin)/admin/website/image-manager/image-manager-client";

const access = vi.hoisted(() => ({ canEdit: true }));
vi.mock("@/hooks/use-admin-area-edit-access", () => ({
  useAdminAreaEditAccess: () => access.canEdit,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

beforeEach(() => {
  access.canEdit = true;
  vi.stubGlobal("fetch", vi.fn(async (input: string) => ({
    ok: true,
    json: async () => input.includes("/directories")
      ? { directories: ["", "photos", "winter"] }
      : { images: [] },
  })));
});

describe("Image Manager folder controls", () => {
  it("selects folders with Enter and Space and names the separate folder actions", async () => {
    const user = userEvent.setup();
    render(<ImageManagerClient />);
    const photos = await screen.findByRole("button", { name: "photos", exact: true });
    const winter = screen.getByRole("button", { name: "winter", exact: true });
    for (let step = 0; step < 15 && document.activeElement !== photos; step++) await user.tab();
    expect(photos).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(photos).toHaveAttribute("aria-current", "true");
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/admin/image-manager/images?dir=photos"));
    for (let step = 0; step < 10 && document.activeElement !== winter; step++) await user.tab();
    await user.keyboard(" ");
    expect(winter).toHaveAttribute("aria-current", "true");
    expect(photos).not.toHaveAttribute("aria-current", "true");

    const rename = screen.getByRole("button", { name: "Rename folder photos" });
    const remove = screen.getByRole("button", { name: "Delete folder photos" });
    expect(photos.contains(rename)).toBe(false);
    expect(photos.contains(remove)).toBe(false);
    expect(rename).toHaveAttribute("type", "button");
    expect(remove).toHaveAttribute("type", "button");
    await user.click(rename);
    expect(screen.getByRole("dialog", { name: "Rename Folder" })).toBeVisible();
    await user.keyboard("{Escape}");
    await user.click(remove);
    expect(screen.getByRole("dialog", { name: "Delete Folder" })).toBeVisible();
  });

  it("keeps folder selection available without exposing edit actions to view-only readers", async () => {
    access.canEdit = false;
    const user = userEvent.setup();
    render(<ImageManagerClient />);
    await user.click(await screen.findByRole("button", { name: "photos", exact: true }));
    expect(screen.getByRole("button", { name: "photos", exact: true })).toHaveAttribute("aria-current", "true");
    expect(screen.queryByRole("button", { name: /Rename folder|Delete folder/ })).not.toBeInTheDocument();
  });
});
