import { screen } from "@testing-library/react";
import { expect, it } from "vitest";

/**
 * The refusals every admin write must survive (#4976, ALP-589): a JSON refusal
 * carrying the route's own sentence, an HTML error page from the web server in
 * front of the app, and a request that never gets an answer.
 *
 * `submit` renders the screen and presses the control, with `answer` standing
 * in for the write's response. Each case then asserts on what the officer
 * reads: the route's sentence, or the screen's own `fallback` — never a JSON
 * parse error and never the browser's "Failed to fetch".
 */
export type FailedWriteCase = {
  submit: (answer: () => Response | Promise<Response>) => Promise<void>;
  fallback: string;
};

export function htmlErrorPage(status: number): Response {
  return new Response("<html><body>Bad Gateway</body></html>", {
    status,
    headers: { "content-type": "text/html" },
  });
}

const ROUTE_SENTENCE = "That record no longer exists.";

export function itShowsEveryRefusal({ submit, fallback }: FailedWriteCase): void {
  it("shows the route's own sentence from a JSON refusal", async () => {
    await submit(() => Response.json({ error: ROUTE_SENTENCE }, { status: 404 }));

    expect(await screen.findByText(ROUTE_SENTENCE)).toBeInTheDocument();
  });

  it.each([500, 502])("shows the fallback, not a parse error, for an HTML %i", async (status) => {
    await submit(() => htmlErrorPage(status));

    expect(await screen.findByText(fallback)).toBeInTheDocument();
    expect(screen.queryByText(/JSON/)).not.toBeInTheDocument();
  });

  it("shows the fallback when the request never gets an answer", async () => {
    await submit(() => Promise.reject(new TypeError("Failed to fetch")));

    expect(await screen.findByText(fallback)).toBeInTheDocument();
    expect(screen.queryByText(/Failed to fetch/)).not.toBeInTheDocument();
  });
}
