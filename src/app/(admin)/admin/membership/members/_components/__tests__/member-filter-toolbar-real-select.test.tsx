// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { emptyFilters } from "../../_utils";
import { MemberFilterToolbar } from "../member-filter-toolbar";

/**
 * The members filter toolbar rendered against the REAL `@/components/ui/select`.
 *
 * WHY THIS FILE EXISTS, AND WHY IT DELIBERATELY MOCKS ALMOST NOTHING.
 * Every other suite in this folder replaces the select module with plain divs.
 * That is reasonable for asserting copy and wiring, but it means the whole
 * Radix runtime — its contexts, and the invariants they enforce — is never
 * exercised anywhere in the unit tests. A `SelectLabel` was added to the
 * Membership Type picker outside a `SelectGroup`; every mocked suite passed,
 * and the members page crashed to its error boundary in a real browser, taking
 * out the E2E that loads `/admin/members`.
 *
 * The trap is that it does NOT need the picker to be opened. A CLOSED Radix
 * `SelectContent` still portals its children into a detached DocumentFragment
 * so it can collect them, so a child that throws on mount throws on PAGE LOAD.
 * `SelectLabel` reads the group context and throws without it:
 * "`SelectLabel` must be used within `SelectGroup`".
 *
 * So the assertion here is deliberately shallow — that the toolbar MOUNTS. The
 * value is entirely in the real module being present, not in what is asserted.
 */

// Option sources fetch in the browser; pin them so this file tests rendering.
vi.mock("@/hooks/use-access-role-options", async () => {
  const { buildFallbackAccessRoleOptions } = await import(
    "@/lib/access-role-definitions"
  );
  const options = buildFallbackAccessRoleOptions();
  return { useAccessRoleOptions: () => options };
});

function renderToolbar() {
  return render(
    <MemberFilterToolbar
      search=""
      filters={emptyFilters}
      // Non-empty on purpose: the picker then renders its club types beside the
      // label, which is the arrangement that shipped broken.
      membershipTypes={[
        { id: "mt-full", key: "FULL", name: "Full", isActive: true },
        { id: "mt-nonmember", key: "NON_MEMBER", name: "Non-Member", isActive: true },
      ]}
      xeroFeatures={{ liveMemberGroupLookups: false, autoLoadContactGroups: false }}
      xeroContactGroupsList={[]}
      onSearchChange={vi.fn()}
      onSetFilter={vi.fn()}
      resetDisabled={true}
      onReset={vi.fn()}
    />,
  );
}

describe("members filter toolbar against the real select primitives (#2978)", () => {
  afterEach(() => cleanup());

  it("mounts without throwing, with every Select still closed", () => {
    // If a Select child violates a Radix context invariant, this render throws
    // and the whole page it belongs to fails the same way in the browser.
    expect(() => renderToolbar()).not.toThrow();
  });

  it("renders the Membership Type picker's trigger", () => {
    renderToolbar();

    expect(
      screen.getByRole("combobox", { name: /membership type/i }),
    ).toBeInTheDocument();
  });
});

/**
 * The same defect, guarded everywhere rather than only on the file that hit it.
 * Cheap, and it covers the two existing correct call sites plus every future one.
 */
describe("every SelectLabel sits inside a SelectGroup", () => {
  function tsxFilesUnder(root: string): string[] {
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "__tests__") continue;
          walk(full);
          continue;
        }
        if (/\.tsx$/.test(entry.name) && !/\.test\.tsx$/.test(entry.name)) {
          found.push(full);
        }
      }
    };
    walk(root);
    return found.sort();
  }

  it("nobody renders a bare <SelectLabel>", () => {
    const offenders: string[] = [];
    for (const file of tsxFilesUnder(path.resolve(process.cwd(), "src"))) {
      // The wrapper that DEFINES SelectLabel legitimately names it.
      if (file.endsWith(path.join("components", "ui", "select.tsx"))) continue;
      const source = readFileSync(file, "utf8");
      if (!source.includes("<SelectLabel")) continue;
      // A file that renders one must also render the group that provides its
      // context. Deliberately coarse - a per-occurrence parse would be a JSX
      // parser, and every real misuse so far has been a file with no group at
      // all.
      if (!source.includes("<SelectGroup")) {
        offenders.push(path.relative(process.cwd(), file).split(path.sep).join("/"));
      }
    }

    expect(
      offenders,
      "Radix's Select.Label reads a context only Select.Group provides, and it " +
        "throws rather than degrading - so a bare <SelectLabel> takes the whole " +
        "page down the moment the select renders. Wrap it in <SelectGroup>.",
    ).toEqual([]);
  });
});
