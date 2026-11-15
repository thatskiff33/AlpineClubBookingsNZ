/**
 * A `sonner` stand-in that writes each toast into the document, so a refusal
 * shown as a toast can be asserted with the same `screen` queries as an inline
 * alert (`failed-write-cases.ts`). Use as
 * `vi.mock("sonner", async () => (await import("…/toast-to-document")).sonnerToDocument)`
 * and clear `document.body` between tests.
 */
function show(message: unknown) {
  const line = document.createElement("p");
  line.textContent = String(message);
  document.body.append(line);
}

export const sonnerToDocument = {
  toast: Object.assign(show, { success: show, error: show, info: show, warning: show }),
  Toaster: () => null,
};
