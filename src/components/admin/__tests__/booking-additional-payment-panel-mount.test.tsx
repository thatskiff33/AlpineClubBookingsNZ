// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, within } from "@testing-library/react";
import { BookingAdditionalPaymentPanelMount } from "@/components/admin/booking-additional-payment-panel-mount";

/** Reproduce CI's hidden streamed page alongside the hydrated visible copy. */
describe("officer additional-payment panel during streaming hydration", () => {
  it("keeps exactly one active panel even while React retains its hidden server stream", async () => {
    const resend = vi.fn();
    const panel = (amount: string) => (
      <BookingAdditionalPaymentPanelMount>
        <div data-testid="additional-payment-outstanding">
          <p>{amount}</p>
          <button onClick={resend}>Resend payment request email</button>
        </div>
      </BookingAdditionalPaymentPanelMount>
    );
    const serverHtml = renderToString(panel("$210.00"));
    const hiddenStream = document.createElement("div");
    hiddenStream.hidden = true;
    hiddenStream.innerHTML = serverHtml;
    const visiblePage = document.createElement("main");
    visiblePage.innerHTML = serverHtml;
    document.body.append(hiddenStream, visiblePage);
    let root: ReturnType<typeof hydrateRoot> | undefined;
    const hydrationError = vi.fn();
    try {
      // The stream contains the loading state, never another set of controls.
      expect(within(document.body).queryAllByTestId("additional-payment-outstanding")).toHaveLength(0);
      await act(async () => {
        root = hydrateRoot(visiblePage, panel("$210.00"), { onRecoverableError: hydrationError });
      });
      expect(hydrationError).not.toHaveBeenCalled();
      const active = within(document.body).getByTestId("additional-payment-outstanding");
      expect(active).toHaveTextContent("$210.00");
      expect(within(hiddenStream).queryByTestId("additional-payment-outstanding")).toBeNull();
      fireEvent.click(within(active).getByRole("button", { name: "Resend payment request email" }));
      expect(resend).toHaveBeenCalledTimes(1);
      // A refreshed amount replaces the live panel without mounting another.
      await act(async () => { root!.render(panel("$100.00")); });
      expect(within(document.body).getByTestId("additional-payment-outstanding")).toHaveTextContent("$100.00");
    } finally {
      await act(async () => { root?.unmount(); });
      hiddenStream.remove();
      visiblePage.remove();
    }
  });
});
