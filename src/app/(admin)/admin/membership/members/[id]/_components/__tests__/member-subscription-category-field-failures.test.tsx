// @vitest-environment jsdom

/**
 * A refused subscription-category load on the seasonal-membership card says
 * why (#4976, ALP-589).
 *
 * The load parsed the reply as JSON before it knew it was a refusal, and
 * passed `err.message` to the card: an HTML 502 from the proxy read as a JSON
 * parse error and a dropped connection as "Failed to fetch". It now reads
 * through the shared response reader, so a route's own sentence is shown and
 * anything else shows the load's fallback.
 */

import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { htmlErrorPage } from "@/lib/__tests__/support/failed-write-cases";
import { MemberSubscriptionCategoryField } from "../member-subscription-category-field";

const FALLBACK = "Failed to load subscription categories";

function loadWith(answer: () => Response | Promise<Response>) {
  vi.stubGlobal("fetch", vi.fn(async () => answer()));
  const onLoadError = vi.fn();
  render(
    <MemberSubscriptionCategoryField
      value=""
      onChange={() => {}}
      currentCategoryId={null}
      onLoadError={onLoadError}
    />,
  );
  return onLoadError;
}

describe("loading the subscription categories for a member", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("reports the route's own sentence from a JSON refusal", async () => {
    const onLoadError = loadWith(() =>
      Response.json({ error: "Categories are unavailable." }, { status: 404 }),
    );

    await waitFor(() => expect(onLoadError).toHaveBeenCalledWith("Categories are unavailable."));
  });

  it.each([500, 502])("reports the fallback, not a parse error, for an HTML %i", async (status) => {
    const onLoadError = loadWith(() => htmlErrorPage(status));

    await waitFor(() => expect(onLoadError).toHaveBeenCalledWith(FALLBACK));
  });

  it("reports the fallback when the request never gets an answer", async () => {
    const onLoadError = loadWith(() => Promise.reject(new TypeError("Failed to fetch")));

    await waitFor(() => expect(onLoadError).toHaveBeenCalledWith(FALLBACK));
  });

  it("reports the fallback for a success reply that is not a category list", async () => {
    const onLoadError = loadWith(() => Response.json({ unexpected: true }));

    await waitFor(() => expect(onLoadError).toHaveBeenCalledWith(FALLBACK));
  });
});
