// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WysiwygEditor } from "@/components/admin/page-content-panel";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

const UPLOADED_IMAGE = {
  id: "img-1",
  filename: "photo.png",
  url: "/api/images/img-1",
  contentType: "image/png",
  byteSize: 1234,
  altText: null,
  width: 64,
  height: 32,
  createdAt: "2026-06-12T00:00:00.000Z",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function openImagePicker() {
  fireEvent.mouseDown(screen.getByText("Image"));
}

describe("WysiwygEditor image picker", () => {
  beforeEach(() => {
    global.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";

      if (url.startsWith("/api/admin/site-images")) {
        return jsonResponse({ images: ["/branding/logo.png"] });
      }

      if (url.startsWith("/api/admin/image-library/")) {
        if (method === "DELETE") {
          return jsonResponse({ success: true, referencedBySlugs: [] });
        }
      }

      if (url.startsWith("/api/admin/image-library")) {
        if (method === "POST") {
          return jsonResponse(
            {
              image: {
                id: "img-new",
                filename: "new_upload.png",
                url: "/api/images/img-new",
                contentType: "image/png",
                byteSize: 100,
                altText: null,
                width: 10,
                height: 10,
                createdAt: "2026-06-13T00:00:00.000Z",
              },
            },
            201,
          );
        }
        return jsonResponse({
          images: [UPLOADED_IMAGE],
          total: 1,
          page: 1,
          pageSize: 100,
        });
      }

      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
  });

  it("merges uploaded images with the existing branding picker", async () => {
    render(<WysiwygEditor value="" onChange={() => {}} />);

    openImagePicker();

    await waitFor(() => {
      expect(screen.getByText("photo.png")).toBeTruthy();
      expect(screen.getByText("/branding/logo.png")).toBeTruthy();
    });

    expect(screen.getByText("Uploaded")).toBeTruthy();
    expect(screen.getByText("Branding")).toBeTruthy();
  });

  it("filters the merged picker list by label across both sources", async () => {
    render(<WysiwygEditor value="" onChange={() => {}} />);

    openImagePicker();
    await waitFor(() => expect(screen.getByText("photo.png")).toBeTruthy());

    fireEvent.change(screen.getByPlaceholderText("Filter images by name"), {
      target: { value: "branding" },
    });

    expect(screen.queryByText("photo.png")).toBeNull();
    expect(screen.getByText("/branding/logo.png")).toBeTruthy();
  });

  it("uploads a new image inline and selects it for insertion", async () => {
    render(<WysiwygEditor value="" onChange={() => {}} />);

    openImagePicker();
    await waitFor(() => expect(screen.getByText("photo.png")).toBeTruthy());

    const file = new File(["fake-bytes"], "new upload.png", {
      type: "image/png",
    });
    const fileInput = document.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files: [file] } });

    await waitFor(() => {
      expect(screen.getByText("new_upload.png")).toBeTruthy();
    });

    expect(screen.getByText("/api/images/img-new")).toBeTruthy();
    const insertButton = screen.getByRole("button", {
      name: "Insert Image",
    }) as HTMLButtonElement;
    expect(insertButton.disabled).toBe(false);
  });

  it("deletes an uploaded image from the picker", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);

    render(<WysiwygEditor value="" onChange={() => {}} />);

    openImagePicker();
    await waitFor(() => expect(screen.getByText("photo.png")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Delete photo.png" }));

    await waitFor(() => {
      expect(screen.queryByText("photo.png")).toBeNull();
    });

    expect(global.fetch).toHaveBeenCalledWith(
      "/api/admin/image-library/img-1",
      expect.objectContaining({ method: "DELETE" }),
    );
    expect(screen.getAllByText("/branding/logo.png").length).toBeGreaterThan(0);
  });

  it("supports keyboard activation of picker items via Enter/Space", async () => {
    render(<WysiwygEditor value="" onChange={() => {}} />);

    openImagePicker();
    await waitFor(() => expect(screen.getByText("photo.png")).toBeTruthy());

    const brandingButton = screen
      .getByText("/branding/logo.png")
      .closest("button");
    expect(brandingButton).not.toBeNull();
    brandingButton?.focus();
    expect(document.activeElement).toBe(brandingButton);

    fireEvent.click(brandingButton as HTMLButtonElement);

    await waitFor(() => {
      const insertButton = screen.getByRole("button", {
        name: "Insert Image",
      }) as HTMLButtonElement;
      expect(insertButton.disabled).toBe(false);
    });
  });
});
