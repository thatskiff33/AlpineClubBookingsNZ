import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  CLUB_FORMAT_REACH,
  CLUB_FORMAT_SERVER_SETTINGS,
} from "@/lib/club-format-copy";
import { stripComments } from "./support/strip-comments";

/**
 * The three in-app surfaces that tell an operator what the Club Currency &
 * Locale setting reaches render ONE copy (#3566 review, `INV-SSOT`). All three
 * went on saying dates followed the server's `LOCALE` after #3566 made that
 * false, because each carried its own sentence. Disk-scanning: run by name.
 */
const SURFACES = [
  "src/app/(admin)/admin/club-format/page.tsx",
  "src/components/admin/club-format-panel.tsx",
  "src/lib/contextual-help/admin/setup-and-configuration.ts",
];

/** Phrases the pre-#3566 copy used, each of which is now false. */
const STALE = [
  /do not move yet/i,
  /Do not remove them yet/i,
  /keep them (?:matching|the same|in step)/i,
  /still follow(?:s|ing)? the server/i,
  /amounts do not yet/i,
];

describe("Club Currency & Locale copy has one home (#3566)", () => {
  it("renders the shared reach and server-settings copy on every surface", () => {
    for (const relative of SURFACES) {
      const code = stripComments(
        readFileSync(path.join(process.cwd(), relative), "utf8"),
      );
      expect(code, relative).toContain("CLUB_FORMAT_REACH");
      expect(code, relative).toContain("CLUB_FORMAT_SERVER_SETTINGS");
      for (const phrase of STALE) {
        expect(code, `${relative} still says ${phrase}`).not.toMatch(phrase);
      }
    }
  });

  it("says what is true: dates and emails follow, chart labels do not", () => {
    expect(CLUB_FORMAT_REACH).toMatch(/every date and time/);
    expect(CLUB_FORMAT_REACH).toMatch(/Emails follow/);
    expect(CLUB_FORMAT_REACH).toMatch(/report charts/);
    expect(CLUB_FORMAT_SERVER_SETTINGS).toMatch(/card payments/);
  });
});
