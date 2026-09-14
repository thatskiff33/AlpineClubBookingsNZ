import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * THE XERO INVOICE WARNING IS NEVER MEMBER-FACING (#3001, MAD epic #2725).
 *
 * The booking detail page is ONE page serving both a member and an officer, and
 * the difference between them is a gate in the loader rather than a different
 * route. So "admin-only" here is not a property of a component — it is the
 * property that the read never runs for a member at all, and it is one ternary
 * wide.
 *
 * A member must never learn that their booking's invoice failed in the club's
 * accounting system, nor read the provider reason attached to it. Dropping that
 * gate would not break a type, fail a render or change a snapshot: it would
 * quietly start running an admin diagnostic for every member who opens their own
 * booking, and the row would then be one careless prop away from their screen.
 *
 * Disk-scanning, so it has no import edge to the loader it inspects and
 * `npm run test:related` cannot select it. CI-caught by design; run it locally
 * with `npm run test:named`.
 */

const LOADER = path.join(
  process.cwd(),
  "src/app/(authenticated)/bookings/[id]/_lib/booking-detail-admin-tools.ts",
);

/** Every production `.ts`/`.tsx` under a root — tests and type declarations excluded. */
function productionFilesUnder(root: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      found.push(...productionFilesUnder(full));
    } else if (
      (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) &&
      !entry.name.includes(".test.") &&
      !entry.name.endsWith(".d.ts")
    ) {
      found.push(full);
    }
  }
  return found;
}

describe("the booking's Xero invoice warning stays behind the admin gate", () => {
  const loader = readFileSync(LOADER, "utf8");

  it("runs the provider-mismatch read only when the viewer is an admin", () => {
    // Matched as the whole assignment, so moving the call out from under the
    // ternary fails here rather than passing on the identifier still appearing
    // somewhere in the file.
    expect(loader).toMatch(
      /const providerMismatches\s*=\s*isAdmin\s*\?\s*await getBookingProviderMismatches\(/,
    );
  });

  it("reads it in exactly one place, so there is one gate and not two", () => {
    expect(loader.match(/getBookingProviderMismatches\(/g)).toHaveLength(1);
  });

  it("routes the invoice-fault read through that one gated caller", () => {
    /*
      `getBookingInvoiceSyncFault` talks to the Xero operation ledger and returns
      provider failure detail. It is admin-only BY INHERITANCE — it has no gate of
      its own and takes its protection entirely from the single caller above. A
      second production caller is therefore a second place needing that gate, and
      the next one added somewhere ungated is exactly how this reaches a member.

      The EXPECTED list is written here; the ACTUAL list is read off the tree. A
      test that discovered both would agree with whatever it found.

      BOTH IMPORT FORMS ARE MATCHED. A census that knew only `from "…"` would be
      silent about `await import("…")`, and this codebase reaches for a dynamic
      import routinely — `xero-sync.ts` loads its hardening module that way in
      the very writers this projection reads. A second caller added dynamically
      is a second place needing the gate, exactly like a static one.
    */
    const expected = ["src/lib/booking-provider-mismatches.ts"];

    const importers = productionFilesUnder(path.join(process.cwd(), "src"))
      .filter((file) =>
        /(?:from|import)\s*\(?\s*["'][^"']*booking-invoice-sync-status["']/.test(
          readFileSync(file, "utf8"),
        ),
      )
      .map((file) => path.relative(process.cwd(), file).split(path.sep).join("/"))
      .sort();

    expect(importers).toEqual(expected);
  });
});
