// @vitest-environment jsdom

import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { adminHref, getAdminPage } from "@/lib/admin-hubs";
import { useAdminListUrlSync } from "@/hooks/use-admin-list-url-sync";

// One router for every render, as Next's is.
const navigation = vi.hoisted(() => {
  const replace = vi.fn();
  return { pathname: "/", search: "", replace, router: { replace } };
});
vi.mock("next/navigation", () => ({
  useRouter: () => navigation.router,
  usePathname: () => navigation.pathname,
  useSearchParams: () => new URLSearchParams(navigation.search),
}));

function Harness({ target }: { target: string }) {
  useAdminListUrlSync(target);
  return null;
}

const PAYMENTS = adminHref("payments");

beforeEach(() => {
  navigation.replace.mockReset();
  navigation.pathname = PAYMENTS;
  navigation.search = "";
});

// #5295: a replace to the address already shown is still a soft navigation,
// which drops the page's <title> until the server streams it back (#5155).
describe("useAdminListUrlSync", () => {
  it.each([
    ["with no query", "", PAYMENTS],
    ["with a query", "status=SUCCEEDED&page=2", `${PAYMENTS}?status=SUCCEEDED&page=2`],
  ])("replaces nothing when the address shown is already the target, %s", (_label, search, target) => {
    navigation.search = search;
    render(<Harness target={target} />);
    expect(navigation.replace).not.toHaveBeenCalled();
  });

  // The Finance pages have moved into a hub: whichever of the two addresses the
  // browser shows, it is the page's own, and the target is in served form.
  it.each([
    ["the old address", getAdminPage("payments").oldPath],
    ["the hub address", getAdminPage("payments").hubPath],
  ])("treats %s as already there", (_label, pathname) => {
    expect(getAdminPage("payments").moved).toBe(true);
    navigation.pathname = pathname;
    render(<Harness target={PAYMENTS} />);
    expect(navigation.replace).not.toHaveBeenCalled();
  });

  it("replaces once to a different target, and again when the target changes", () => {
    const view = render(<Harness target={`${PAYMENTS}?page=2`} />);
    expect(navigation.replace).toHaveBeenCalledTimes(1);
    expect(navigation.replace).toHaveBeenLastCalledWith(`${PAYMENTS}?page=2`, { scroll: false });

    view.rerender(<Harness target={`${PAYMENTS}?page=2`} />);
    expect(navigation.replace).toHaveBeenCalledTimes(1);

    view.rerender(<Harness target={`${PAYMENTS}?page=3`} />);
    expect(navigation.replace).toHaveBeenCalledTimes(2);
    expect(navigation.replace).toHaveBeenLastCalledWith(`${PAYMENTS}?page=3`, { scroll: false });
  });

  it("rewrites the same query in another order to the target's order, once", () => {
    navigation.search = "page=2&status=SUCCEEDED";
    render(<Harness target={`${PAYMENTS}?status=SUCCEEDED&page=2`} />);
    expect(navigation.replace).toHaveBeenCalledTimes(1);
  });
});
