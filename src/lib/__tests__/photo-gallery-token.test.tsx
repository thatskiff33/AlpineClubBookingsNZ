// @vitest-environment jsdom

import { render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PhotoGalleryToken } from "@/components/website/photo-gallery-token";

const mocks = vi.hoisted(() => ({
  init: vi.fn(),
  destroy: vi.fn(),
  loadAndOpen: vi.fn(),
  on: vi.fn(),
}));

vi.mock("@/lib/photoswipe-lightbox", () => ({
  default: vi.fn().mockImplementation(function PhotoSwipeLightboxMock() {
    return {
      init: mocks.init,
      destroy: mocks.destroy,
      loadAndOpen: mocks.loadAndOpen,
      on: mocks.on,
    };
  }),
  loadPhotoSwipeModule: vi.fn(),
}));

describe("PhotoGalleryToken", () => {
  let frameCallbacks: Map<number, FrameRequestCallback>;
  let nextFrameId: number;

  beforeEach(() => {
    vi.clearAllMocks();
    frameCallbacks = new Map();
    nextFrameId = 1;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      const id = nextFrameId;
      nextFrameId += 1;
      frameCallbacks.set(id, callback);
      return id;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
      frameCallbacks.delete(id);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const runAnimationFrames = () => {
    const callbacks = Array.from(frameCallbacks.values());
    frameCallbacks.clear();
    callbacks.forEach((callback) => callback(performance.now()));
  };

  it("auto-opens the slideshow lightbox after an animation frame", async () => {
    render(
      <PhotoGalleryToken
        galleryId="slideshow"
        variant="slideshow"
        images={[
          {
            src: "/api/images/photo-1",
            alt: "Lodge",
            width: 1200,
            height: 800,
          },
        ]}
      />,
    );

    await waitFor(() => expect(mocks.init).toHaveBeenCalled());
    expect(mocks.loadAndOpen).not.toHaveBeenCalled();

    runAnimationFrames();

    expect(mocks.loadAndOpen).toHaveBeenCalledTimes(1);
    expect(mocks.loadAndOpen).toHaveBeenCalledWith(0, {
      gallery: document.getElementById("slideshow"),
    });
  });

  it("does not auto-open ordinary gallery tokens", async () => {
    render(
      <PhotoGalleryToken
        galleryId="gallery"
        variant="gallery"
        images={[
          {
            src: "/api/images/photo-1",
            alt: "Lodge",
            width: 1200,
            height: 800,
          },
        ]}
      />,
    );

    await waitFor(() => expect(mocks.init).toHaveBeenCalled());

    runAnimationFrames();

    expect(window.requestAnimationFrame).not.toHaveBeenCalled();
    expect(mocks.loadAndOpen).not.toHaveBeenCalled();
  });

  it("gives gallery images with no alt a positional fallback instead of empty alt (#1947)", () => {
    const { container } = render(
      <PhotoGalleryToken
        galleryId="gallery"
        variant="gallery"
        images={[
          { src: "data:image/png;base64,AAAA", alt: "", width: 10, height: 10 },
          { src: "/api/images/lodge.jpg", alt: "Lodge front", width: 20, height: 20 },
        ]}
      />,
    );

    const imgs = Array.from(container.querySelectorAll("img"));
    expect(imgs[0]?.getAttribute("alt")).toBe("Gallery image 1");
    expect(imgs[1]?.getAttribute("alt")).toBe("Lodge front");
    // No gallery image renders an empty alt.
    expect(imgs.every((img) => (img.getAttribute("alt") ?? "").length > 0)).toBe(
      true,
    );
  });

  it("pins the gallery caption fallback chain: alt as caption, else 'Open image' (#1947)", () => {
    const { container } = render(
      <PhotoGalleryToken
        galleryId="gallery"
        variant="gallery"
        images={[
          // A derived/authored non-empty alt is shown verbatim as the caption.
          { src: "/api/images/Lodge_Winter.jpg", alt: "Lodge Winter", width: 20, height: 20 },
          // An empty alt (e.g. a data: image the sanitiser marked decorative)
          // falls the caption back to "Open image" while the <img> alt still
          // gets the positional accessible name.
          { src: "data:image/png;base64,AAAA", alt: "", width: 10, height: 10 },
        ]}
      />,
    );

    const captions = Array.from(
      container.querySelectorAll<HTMLDivElement>("a > div:last-child"),
    ).map((node) => node.textContent);
    expect(captions).toEqual(["Lodge Winter", "Open image"]);

    const imgs = Array.from(container.querySelectorAll("img"));
    expect(imgs[1]?.getAttribute("alt")).toBe("Gallery image 2");
  });

  it("cancels a pending slideshow auto-open on unmount", async () => {
    const { unmount } = render(
      <PhotoGalleryToken
        galleryId="slideshow"
        variant="slideshow"
        images={[
          {
            src: "/api/images/photo-1",
            alt: "Lodge",
            width: 1200,
            height: 800,
          },
        ]}
      />,
    );

    await waitFor(() => expect(mocks.init).toHaveBeenCalled());

    unmount();
    runAnimationFrames();

    expect(window.cancelAnimationFrame).toHaveBeenCalledWith(1);
    expect(mocks.loadAndOpen).not.toHaveBeenCalled();
  });
  // #4935 (INV-PUB-005): website-sized copies in srcset; full view opens the widest.
  const base = "/api/images/uploaded/album";
  const withCopies = {
    src: `${base}/Ruapehu, summit.jpg`,
    alt: "Summit",
    width: 4000,
    height: 3000,
    copies: [
      { src: `${base}/.sizes/Ruapehu, summit.jpg.400.webp`, width: 400, height: 300 },
      { src: `${base}/.sizes/Ruapehu, summit.jpg.800.webp`, width: 800, height: 600 },
      { src: `${base}/.sizes/Ruapehu, summit.jpg.1600.webp`, width: 1600, height: 1200 },
    ],
  };

  it("serves a photo with copies through srcset and opens the widest copy full size", () => {
    const { container } = render(
      <PhotoGalleryToken galleryId="g" variant="gallery" images={[withCopies]} />,
    );
    const link = container.querySelector("a")!;
    const img = container.querySelector("img")!;

    expect(link.getAttribute("href")).toBe(withCopies.copies[2]!.src);
    expect(link.getAttribute("data-pswp-width")).toBe("1600");
    expect(link.getAttribute("data-pswp-height")).toBe("1200");
    expect(img.getAttribute("src")).toBe(withCopies.copies[1]!.src);
    // Spaces and commas escaped: a srcset parser would split on either.
    expect(img.getAttribute("srcset")).toBe(
      [400, 800, 1600]
        .map((w) => `${base}/.sizes/Ruapehu%2C%20summit.jpg.${w}.webp ${w}w`)
        .join(", "),
    );
    expect(img.getAttribute("sizes")).toBe(
      "(min-width: 1024px) 33vw, (min-width: 640px) 50vw, 100vw",
    );
    // Layout keeps the original's aspect ratio.
    expect(img.getAttribute("width")).toBe("4000");
    // The full-size original is not requested anywhere on the page.
    expect(container.innerHTML).not.toContain(`${base}/Ruapehu, summit.jpg"`);
  });

  it("escapes a # in a copy's srcset URL so the browser does not cut it at a fragment", () => {
    const copy = { src: `${base}/.sizes/hut#2.jpg.400.webp`, width: 400, height: 300 };
    const { container } = render(
      <PhotoGalleryToken
        galleryId="g"
        variant="gallery"
        images={[{ src: `${base}/hut#2.jpg`, alt: "Hut", width: 800, height: 600, copies: [copy] }]}
      />,
    );
    expect(container.querySelector("img")!.getAttribute("srcset")).toBe(
      `${base}/.sizes/hut%232.jpg.400.webp 400w`,
    );
  });

  // #5087 review: the lightbox link and the fallback src are URLs too.
  it("escapes a # in the lightbox link and the src, with or without copies", () => {
    const copy = { src: `${base}/.sizes/hut#2.jpg.400.webp`, width: 400, height: 300 };
    const { container } = render(
      <PhotoGalleryToken
        galleryId="g"
        variant="gallery"
        images={[
          { src: `${base}/hut#2.jpg`, alt: "Hut", width: 800, height: 600, copies: [copy] },
          { src: `${base}/hut#3.gif`, alt: "Hut 3", width: 640, height: 480 },
        ]}
      />,
    );
    const [withCopy, without] = [...container.querySelectorAll("a")];
    expect(withCopy!.getAttribute("href")).toBe(`${base}/.sizes/hut%232.jpg.400.webp`);
    expect(withCopy!.querySelector("img")!.getAttribute("src")).toBe(
      `${base}/.sizes/hut%232.jpg.400.webp`,
    );
    expect(without!.getAttribute("href")).toBe(`${base}/hut%233.gif`);
    expect(without!.querySelector("img")!.getAttribute("src")).toBe(`${base}/hut%233.gif`);
  });

  it("renders a photo with no copies exactly as before: the original, no srcset", () => {
    const { container } = render(
      <PhotoGalleryToken
        galleryId="g"
        variant="gallery"
        images={[{ src: `${base}/hut.gif`, alt: "Hut", width: 640, height: 480 }]}
      />,
    );
    const link = container.querySelector("a")!;
    const img = container.querySelector("img")!;
    expect(link.getAttribute("href")).toBe(`${base}/hut.gif`);
    expect(link.getAttribute("data-pswp-width")).toBe("640");
    expect(img.getAttribute("src")).toBe(`${base}/hut.gif`);
    expect(img.hasAttribute("srcset")).toBe(false);
    expect(img.hasAttribute("sizes")).toBe(false);
  });

  it("sizes slideshow copies for the wider slideshow frame", () => {
    const { container } = render(
      <PhotoGalleryToken galleryId="s" variant="slideshow" images={[withCopies]} />,
    );
    expect(container.querySelector("img")!.getAttribute("sizes")).toBe(
      "(min-width: 1024px) 80vw, 100vw",
    );
  });
});
