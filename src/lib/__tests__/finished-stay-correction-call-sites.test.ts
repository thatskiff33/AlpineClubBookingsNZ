import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { stripComments } from "@/lib/__tests__/support/strip-comments";

/**
 * #3750: `finishedStayCorrection` lifts the fully-past edit lock on a booking.
 * It is a SERVICE ARGUMENT to `modifyBookingBatch`, never a field a route reads
 * from a request body, and exactly one caller may pass it: the executor of an
 * officer-approved LOCKED_PERIOD change request
 * (`booking-change-request-execution.ts`), which claims the request in the same
 * transaction. Member self-service on a finished stay stays locked (owner
 * decision, 6 Oct 2026).
 *
 * The population is every non-test source file under `src/`, by WALK rather
 * than by name, so a new route or service that starts passing the flag is seen
 * the day its file exists. WHAT THIS CANNOT SEE: the flag reached through a
 * renamed variable or a spread of an object built elsewhere — it reads text. The
 * service's own guards (tx + preTransaction + ADMIN) are what hold then, and
 * they are pinned below too.
 */

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const EXECUTOR = "src/lib/booking-change-request-execution.ts";
const SERVICE = "src/lib/booking-batch-modification-service.ts";

function sourceFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "__tests__" || entry.name === "node_modules") continue;
        walk(full);
      } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        found.push(path.relative(REPO_ROOT, full).split(path.sep).join("/"));
      }
    }
  };
  walk(path.join(REPO_ROOT, "src"));
  return found.sort();
}

const read = (relative: string): string =>
  stripComments(fs.readFileSync(path.join(REPO_ROOT, relative), "utf8"));

const naming = (token: string): string[] =>
  sourceFiles().filter((file) => read(file).includes(token));

describe("finishedStayCorrection call sites (#3750)", () => {
  it("the population is real, so the census is not vacuous", () => {
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(500);
    expect(files).toContain(EXECUTOR);
    expect(files).toContain(SERVICE);
  });

  it("is named only by the executor and the modules that implement the mode", () => {
    expect(naming("finishedStayCorrection")).toEqual([
      "src/lib/booking-batch-modification-service.ts",
      "src/lib/booking-change-request-execution.ts",
      "src/lib/booking-edit-policy.ts",
      "src/lib/booking-modify-validation.ts",
    ]);
  });

  it("is passed to modifyBookingBatch by the executor alone", () => {
    const callers = sourceFiles().filter((file) => {
      const code = read(file);
      return (
        file !== SERVICE &&
        code.includes("modifyBookingBatch(") &&
        code.includes("finishedStayCorrection")
      );
    });
    expect(callers).toEqual([EXECUTOR]);
    expect(read(EXECUTOR)).toContain(
      "finishedStayCorrection: { changeRequestId: requestId }",
    );
  });

  it("no route reads it from a request: nothing under src/app names it", () => {
    expect(naming("finishedStayCorrection").filter((file) => file.startsWith("src/app/"))).toEqual(
      [],
    );
  });

  it("the service refuses it outside a caller transaction, from a non-officer, or with the date override", () => {
    const service = read(SERVICE);
    expect(service).toContain("if (!callerTx || !preTransaction) {");
    expect(service).toContain('if (actor.role !== "ADMIN") {');
    expect(service).toContain(
      '"#3750: a finished-stay correction is not a date-only admin override."',
    );
    // And refuses when the policy did not actually engage the mode.
    expect(service).toContain("if (!dates.isFinishedStayCorrection) {");
  });
});
