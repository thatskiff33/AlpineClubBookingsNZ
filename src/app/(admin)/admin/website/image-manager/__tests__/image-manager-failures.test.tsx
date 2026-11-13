// @vitest-environment jsdom

/**
 * A refused upload or folder action says why (#4976, ALP-589).
 *
 * The upload parsed the reply as JSON with no catch, and the folder actions
 * parsed a refusal the same way, so an HTML 502 from the proxy read as a JSON
 * parse error and a dropped connection as "Failed to fetch" — or, for a
 * folder action, "An error occurred". A 403 still raises the forbidden-save
 * notice.
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from "@/lib/__tests__/support/club-time-render";
import { afterEach, describe, expect, it, vi } from "vitest";
import { itShowsEveryRefusal } from "@/lib/__tests__/support/failed-write-cases";
import { ADMIN_FORBIDDEN_SAVE_REASON } from "@/components/admin/view-only-action";

vi.mock("@/hooks/use-admin-area-edit-access", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/hooks/use-admin-area-edit-access")),
  useAdminAreaEditAccess: () => true,
}));
vi.mock("sonner", async () => (await import("@/lib/__tests__/support/toast-to-document")).sonnerToDocument);

import { ImageManagerClient } from "../image-manager-client";

type Answer = () => Response | Promise<Response>;

function installFetch({ upload, deleteFolder }: { upload?: Answer; deleteFolder?: Answer }) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/admin/image-manager/upload") {
      return (upload ?? (() => Response.json({ results: [{ filename: "hut.png", ok: true }] })))();
    }
    if (url === "/api/admin/image-manager/directories" && init?.method === "DELETE") {
      return (deleteFolder ?? (() => Response.json({ ok: true })))();
    }
    if (url.startsWith("/api/admin/image-manager/directories")) {
      return Response.json({ directories: ["", "photos"] });
    }
    return Response.json({ images: [] });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function uploadAnImage() {
  const { container } = render(<ImageManagerClient />);
  await screen.findByRole("button", { name: "photos" });
  const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
  fireEvent.change(input, { target: { files: [new File(["png"], "hut.png", { type: "image/png" })] } });
}

async function deleteTheFolder() {
  render(<ImageManagerClient />);
  fireEvent.click(await screen.findByRole("button", { name: "Delete folder photos" }));
  const dialog = await screen.findByRole("dialog", { name: "Delete Folder" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
}

const imageLoads = (fetchMock: ReturnType<typeof installFetch>) =>
  fetchMock.mock.calls.filter(([input]) => String(input).startsWith("/api/admin/image-manager/images"));
const directoryLoads = (fetchMock: ReturnType<typeof installFetch>) =>
  fetchMock.mock.calls.filter(([input, init]) => String(input).startsWith("/api/admin/image-manager/directories") && !init?.method);

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("image manager refusals", () => {
  describe("uploading an image", () => {
    itShowsEveryRefusal({
      fallback: "Upload failed",
      submit: async (answer) => {
        installFetch({ upload: answer });
        await uploadAnImage();
      },
    });

    it("reloads the gallery on success", async () => {
      const fetchMock = installFetch({});
      await uploadAnImage();

      expect(await screen.findByText("1 image uploaded")).toBeInTheDocument();
      await waitFor(() => expect(imageLoads(fetchMock)).toHaveLength(2));
    });
  });

  describe("deleting a folder", () => {
    itShowsEveryRefusal({
      fallback: "Failed to delete directory",
      submit: async (answer) => {
        installFetch({ deleteFolder: answer });
        await deleteTheFolder();
      },
    });

    it("raises the forbidden-save notice for a 403", async () => {
      installFetch({ deleteFolder: () => Response.json({ error: "Forbidden" }, { status: 403 }) });
      await deleteTheFolder();

      expect(await screen.findByText(ADMIN_FORBIDDEN_SAVE_REASON, { exact: false })).toBeInTheDocument();
    });

    it("reloads the folders on success", async () => {
      const fetchMock = installFetch({});
      await deleteTheFolder();

      expect(await screen.findByText("Directory deleted")).toBeInTheDocument();
      await waitFor(() => expect(directoryLoads(fetchMock)).toHaveLength(2));
    });
  });
});
