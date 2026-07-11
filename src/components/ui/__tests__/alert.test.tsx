// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { createRef } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Alert } from "@/components/ui/alert";

describe("Alert primitive (#1802)", () => {
  it("pairs an aria-hidden icon with the text (colour is never the sole signal)", () => {
    const { container } = render(<Alert variant="success">Saved</Alert>);
    const icon = container.querySelector("svg");
    expect(icon).not.toBeNull();
    expect(icon).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByText("Saved")).toBeInTheDocument();
  });

  it("renders a DISTINCT icon per variant (colour-blind users must tell them apart)", () => {
    // Guards against variantIcon collapsing to one glyph: if every variant drew
    // the same icon, colour would silently become the sole differentiator.
    const variants = ["info", "success", "warning", "error"] as const;
    const iconClasses = variants.map((variant) => {
      const { container, unmount } = render(<Alert variant={variant}>x</Alert>);
      const cls = container.querySelector("svg")?.getAttribute("class") ?? "";
      unmount();
      return cls;
    });
    // lucide tags each glyph with a distinct `lucide-<name>` class.
    expect(new Set(iconClasses).size).toBe(variants.length);
  });

  it("defaults role to status for info/success and alert for warning/error", () => {
    const { rerender } = render(<Alert variant="info">i</Alert>);
    expect(screen.getByRole("status")).toBeInTheDocument();

    rerender(<Alert variant="success">s</Alert>);
    expect(screen.getByRole("status")).toBeInTheDocument();

    rerender(<Alert variant="warning">w</Alert>);
    expect(screen.getByRole("alert")).toBeInTheDocument();

    rerender(<Alert variant="error">e</Alert>);
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("lets a caller-supplied role override the default", () => {
    render(
      <Alert variant="info" role="alert">
        override
      </Alert>,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("override");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("forwards ref to the root and merges caller className / spreads props", () => {
    const ref = createRef<HTMLDivElement>();
    render(
      <Alert
        ref={ref}
        variant="error"
        id="members-error"
        tabIndex={-1}
        className="scroll-mt-20 focus:outline-none"
      >
        Boom
      </Alert>,
    );
    const root = ref.current;
    expect(root).not.toBeNull();
    // ref lands on the element the members page focuses/scrolls to
    expect(root).toHaveAttribute("id", "members-error");
    expect(root).toHaveAttribute("tabindex", "-1");
    expect(root).toHaveAttribute("role", "alert");
    // caller className is merged last so scroll-mt-20 / focus outline survive
    expect(root).toHaveClass("scroll-mt-20");
    expect(root).toHaveClass("focus:outline-none");
    // variant reads from the semantic token, not a raw palette colour
    expect(root?.className).toContain("text-destructive");
    expect(root?.className).not.toContain("bg-red-50");
  });

  it("keeps inline children (text + Dismiss button) in document flow", () => {
    render(
      <Alert variant="warning">
        Something happened
        <button type="button">Dismiss</button>
      </Alert>,
    );
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Something happened");
    expect(
      screen.getByRole("button", { name: "Dismiss" }),
    ).toBeInTheDocument();
  });
});
