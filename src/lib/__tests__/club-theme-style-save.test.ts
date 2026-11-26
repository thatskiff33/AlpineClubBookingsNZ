/**
 * ALP-723: an AI app connection's site style save (`saveClubThemeStyle`)
 * writes the colours, fonts and custom CSS and nothing else. Because it never
 * names the logo columns or the setup date, it cannot revert a logo a browser
 * save has just set, delete that logo's image, or complete setup, whatever the
 * timing of the two saves.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  tx: {
    clubTheme: { createMany: vi.fn(), update: vi.fn() },
    mediaImage: { deleteMany: vi.fn(), findFirst: vi.fn() },
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { $transaction: (run: (tx: typeof h.tx) => unknown) => run(h.tx) },
}));

import { saveClubThemeStyle } from "@/lib/club-theme";

const style = {
  brandGold: "#112233",
  brandDeep: "#1d3557",
  brandSafety: "#e63946",
  headingFontKey: "INTER" as const,
  bodyFontKey: "LORA" as const,
  rawCss: ".hero{margin:0}",
};

beforeEach(() => {
  vi.clearAllMocks();
  h.tx.clubTheme.update.mockResolvedValue({
    id: "default",
    ...style,
    logoUrl: "/api/images/logo-b",
    logoDataUrl: null,
    completedAt: new Date("2026-06-01T00:00:00.000Z"),
  });
});

describe("saveClubThemeStyle", () => {
  it("writes only the style columns, so the stored logo and setup date stay as they are", async () => {
    const theme = await saveClubThemeStyle(style);

    const STYLE_COLUMNS = ["bodyFontKey", "brandDeep", "brandGold", "brandSafety", "headingFontKey", "rawCss"];
    const [{ data }] = h.tx.clubTheme.update.mock.calls[0] as [{ data: Record<string, unknown> }];
    expect(Object.keys(data).sort()).toEqual(STYLE_COLUMNS);
    const [{ data: created }] = h.tx.clubTheme.createMany.mock.calls[0] as [{ data: Array<Record<string, unknown>> }];
    expect(Object.keys(created[0] ?? {}).sort()).toEqual(["id", ...STYLE_COLUMNS].sort());
    expect(h.tx.mediaImage.deleteMany).not.toHaveBeenCalled();

    // The answer reports the logo the row holds now, as the admin screens show it.
    expect(theme).toMatchObject({ logoUrl: "/api/images/logo-b", completedAt: "2026-06-01T00:00:00.000Z" });
  });
});
