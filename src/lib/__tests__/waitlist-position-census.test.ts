import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { stripComments } from "./support/strip-comments";
import { moduleImports, productionSourceFiles } from "./support/static-import-graph";

// #5402 (`INV-CAP-041`): a waitlist position is read from the live queue by
// `src/lib/waitlist-queue.ts`, and nothing stores it. Five places used to count
// "WAITLISTED, same lodge, overlapping, joined earlier" by hand, and one stored
// the result once and never updated it. This census fails if either comes back.

const QUEUE_MODULE = "src/lib/waitlist-queue.ts";

const sources = productionSourceFiles()
  .filter((file) => /\.(ts|tsx)$/.test(file))
  .map((file) => ({
    file,
    code: stripComments(readFileSync(path.join(process.cwd(), file), "utf8")),
  }));

/**
 * Files that read a `waitlistPosition` FIELD of something other than a booking
 * row: the API or preview payload the position reader filled in.
 */
const POSITION_PAYLOAD_READERS: Record<string, string> = {
  "src/app/(admin)/admin/booking-desk/waitlist/page.tsx": "the admin waitlist API's entries",
  "src/app/(admin)/admin/membership/members/[id]/_components/member-seasonal-membership-card.tsx":
    "the member record preview's waitlist records",
  "src/components/admin/admin-return-to-waitlist-controls.tsx": "the return-to-waitlist response",
  "src/app/api/admin/bookings/[id]/return-to-waitlist/route.ts": "its own transaction result",
};

describe("waitlist position census (#5402, INV-CAP-041)", () => {
  it("reads the production tree", () => {
    expect(sources.length).toBeGreaterThan(500);
    expect(sources.some(({ file }) => file === QUEUE_MODULE)).toBe(true);
  });

  it("counts the queue ahead of a booking only in waitlist-queue.ts", () => {
    const offenders = sources.flatMap(({ file, code }) => {
      if (file === QUEUE_MODULE) return [];
      return [...code.matchAll(/createdAt\s*:\s*\{\s*lte?\s*:/g)]
        .filter((match) => {
          const window = code.slice(Math.max(0, match.index - 600), match.index + 200);
          return /\bWAITLISTED\b/.test(window);
        })
        .map((match) => `${file}:${code.slice(0, match.index).split("\n").length}`);
    });
    expect(
      offenders,
      "a WAITLISTED query bounded by an earlier createdAt is a hand-rolled position count; use getWaitlistPositions from waitlist-queue.ts",
    ).toEqual([]);
  });

  it("never selects the stored column, and writes it only as null", () => {
    const offenders = sources.flatMap(({ file, code }) => {
      const found: string[] = [];
      if (/\bwaitlistPosition\s*:\s*true\b/.test(code)) found.push(`${file}: selects the stored column`);
      for (const match of code.matchAll(/\bdata\s*:\s*\{[^{}]*\bwaitlistPosition\b(?!\s*:\s*null\b)/g)) {
        found.push(`${file}:${code.slice(0, match.index).split("\n").length}: writes a non-null position`);
      }
      return found;
    });
    expect(offenders).toEqual([]);
  });

  it("reads a position field only off a payload the reader filled in", () => {
    const readers = sources
      .filter(({ code }) => /\.\s*waitlistPosition\b/.test(code))
      .map(({ file }) => file)
      .sort();
    expect(readers).toEqual(Object.keys(POSITION_PAYLOAD_READERS).sort());
  });

  it("keeps waitlist-queue.ts a leaf, so booking-create can import it without a cycle", () => {
    const { code } = sources.find(({ file }) => file === QUEUE_MODULE)!;
    const runtimeImports = moduleImports(QUEUE_MODULE, code)
      .filter((entry) => entry.kind !== "type")
      .map((entry) => entry.specifier)
      .sort();
    expect(runtimeImports).toEqual(["@/config/club-settings-defaults", "@prisma/client"]);
  });
});
