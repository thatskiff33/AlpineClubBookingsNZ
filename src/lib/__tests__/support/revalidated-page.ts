import { existsSync } from "node:fs";
import path from "node:path";
import { expect } from "vitest";

/**
 * #3635: a `revalidatePath(pattern, "page")` call refreshes a page only when
 * the pattern names that page's FILE, route groups included. Asserting the
 * string a route passes proves nothing about whether it matches; this asserts
 * that some "page" call on the mock resolves to `pageFile` on disk.
 */
export function expectRevalidatesPageFile(
  revalidatePath: { mock: { calls: unknown[][] } },
  pageFile: string,
): void {
  const expected = path.resolve(pageFile);
  expect(existsSync(expected), `${pageFile} must exist`).toBe(true);
  const targeted = revalidatePath.mock.calls
    .filter(([, type]) => type === "page")
    .map(([pattern]) => path.resolve("src/app", `.${String(pattern)}`, "page.tsx"));
  expect(targeted).toContain(expected);
}
