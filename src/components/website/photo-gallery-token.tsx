"use client";

import { useEffect } from "react";
import PhotoSwipeLightbox, {
  loadPhotoSwipeModule,
} from "@/lib/photoswipe-lightbox";

import type {
  PhotoGalleryImage,
  PhotoGalleryImageCopy,
} from "@/lib/page-content-embeds";

// The rendered width of one card, per the container classes below: three
// columns from `lg`, two from `sm`, one below; a slideshow card is 80% of the
// row from `lg`. The browser picks the narrowest copy covering this (#4935).
const GALLERY_IMAGE_SIZES =
  "(min-width: 1024px) 33vw, (min-width: 640px) 50vw, 100vw";
const SLIDESHOW_IMAGE_SIZES = "(min-width: 1024px) 80vw, 100vw";

/**
 * A URL as one `srcset` candidate. Uploaded file names may hold spaces and
 * commas, which a `srcset` parser reads as separators, and `#`, which would
 * cut the URL at a fragment, so all are escaped; the serving route decodes
 * them back.
 */
function srcsetUrl(src: string): string {
  return encodeURI(src).replace(/[,#]/g, encodeURIComponent);
}

/**
 * A URL as a plain `src` or link `href`. Spaces and commas are fine there, but
 * a `#` (which uploaded names may hold) still cuts the URL at a fragment, so a
 * photo named `hut#2.jpg` would open a 404 in the lightbox (#5087 review).
 */
function attributeUrl(src: string): string {
  return src.replace(/#/g, "%23");
}

/**
 * How one photo renders (#4935, INV-PUB-005). With copies: the thumbnail is a
 * `srcset` of them with the middle one as the fallback `src`, and the
 * full-size view opens the widest. Without: the original everywhere, exactly
 * as before copies existed.
 */
function imageSources(image: PhotoGalleryImage) {
  const copies: PhotoGalleryImageCopy[] = image.copies ?? [];
  const widest = copies.at(-1);
  if (!widest) {
    const src = attributeUrl(image.src);
    return {
      thumbnailSrc: src,
      srcSet: undefined,
      carouselSrc: src,
      full: { src, width: image.width, height: image.height },
    };
  }
  const middle = copies[Math.floor(copies.length / 2)] ?? widest;
  return {
    thumbnailSrc: attributeUrl(middle.src),
    srcSet: copies
      .map((copy) => `${srcsetUrl(copy.src)} ${copy.width}w`)
      .join(", "),
    carouselSrc: attributeUrl((copies[0] ?? widest).src),
    full: { ...widest, src: attributeUrl(widest.src) },
  };
}

type PhotoGalleryTokenProps = {
  galleryId: string;
  images: PhotoGalleryImage[];
  variant?: "gallery" | "slideshow";
};

export function PhotoGalleryToken({
  galleryId,
  images,
  variant = "gallery",
}: PhotoGalleryTokenProps) {
  useEffect(() => {
    if (images.length === 0) {
      return;
    }

    const galleryElement = document.getElementById(galleryId);
    if (!galleryElement) {
      return;
    }

    const lightbox = new PhotoSwipeLightbox({
      gallery: galleryElement,
      children: "a",
      pswpModule: loadPhotoSwipeModule,
    });

    if (variant === "slideshow") {
      lightbox.on("uiRegister", () => {
        const pswp = lightbox.pswp;
        if (!pswp?.ui) {
          return;
        }

        pswp.ui.registerElement({
          name: "thumbnailCarousel",
          className: "pswp__thumbnail-carousel-wrap",
          appendTo: "wrapper",
          order: 35,
          isButton: false,
          onInit: (element, pswp) => {
            element.setAttribute("aria-label", "Slideshow thumbnails");

            const track = document.createElement("div");
            track.className = "pswp__thumbnail-carousel";
            element.appendChild(track);

            const centerThumbnailInTrack = (
              thumbnailButton: HTMLButtonElement,
            ) => {
              const maxScrollLeft = track.scrollWidth - track.clientWidth;
              if (maxScrollLeft <= 0) {
                return;
              }

              const deltaToCenter =
                thumbnailButton.offsetLeft +
                thumbnailButton.offsetWidth / 2 -
                track.clientWidth / 2;
              const targetScrollLeft = Math.min(
                maxScrollLeft,
                Math.max(0, deltaToCenter),
              );

              track.scrollTo({
                left: targetScrollLeft,
                behavior: "auto",
              });
            };

            const buttons = images.map((image, index) => {
              const button = document.createElement("button");
              button.type = "button";
              button.className = "pswp__thumbnail-carousel-item";
              button.setAttribute("aria-label", `Open slide ${index + 1}`);
              button.addEventListener("click", () => {
                pswp.goTo(index);
              });

              const thumbnail = document.createElement("img");
              thumbnail.src = imageSources(image).carouselSrc;
              thumbnail.alt = image.alt || `Slide ${index + 1}`;
              thumbnail.loading = "lazy";
              thumbnail.className = "pswp__thumbnail-carousel-image";
              button.appendChild(thumbnail);

              track.appendChild(button);
              return button;
            });

            const updateActiveThumbnail = () => {
              buttons.forEach((button, index) => {
                const isActive = index === pswp.currIndex;
                button.classList.toggle("is-active", isActive);
                button.setAttribute(
                  "aria-current",
                  isActive ? "true" : "false",
                );

                if (isActive) {
                  centerThumbnailInTrack(button);
                }
              });
            };

            pswp.on("change", updateActiveThumbnail);
            updateActiveThumbnail();
          },
        });
      });
    }

    lightbox.init();

    let autoOpenFrame: number | null = null;

    if (variant === "slideshow" && galleryElement.querySelector("a")) {
      autoOpenFrame = window.requestAnimationFrame(() => {
        if (document.getElementById(galleryId) !== galleryElement) {
          return;
        }

        lightbox.loadAndOpen(0, { gallery: galleryElement });
      });
    }

    return () => {
      if (autoOpenFrame !== null) {
        window.cancelAnimationFrame(autoOpenFrame);
      }
      lightbox.destroy();
    };
  }, [galleryId, images, variant]);

  if (images.length === 0) {
    return (
      <div className="rounded-2xl border border-brand-ridge/20 bg-brand-mist/35 p-6 text-sm text-brand-deep/70">
        No gallery images were found on this page. Add images to the page body
        and place the <code>{"{{photo-gallery}}"}</code> or{" "}
        <code>{"{{photo-slideshow}}"}</code> token where you want the gallery to
        appear.
      </div>
    );
  }

  const containerClassName =
    variant === "slideshow"
      ? "grid gap-4 overflow-x-auto snap-x snap-mandatory lg:grid-flow-col lg:auto-cols-[80%]"
      : "grid gap-4 sm:grid-cols-2 lg:grid-cols-3";

  const cardClassName =
    variant === "slideshow"
      ? "group snap-start overflow-hidden rounded-3xl border border-brand-ridge/20 bg-card shadow-sm transition-transform duration-200 hover:-translate-y-1 hover:shadow-lg"
      : "group overflow-hidden rounded-3xl border border-brand-ridge/20 bg-card shadow-sm transition-transform duration-200 hover:-translate-y-1 hover:shadow-lg";

  const imageWrapperClassName =
    variant === "slideshow"
      ? "aspect-[16/10] overflow-hidden bg-brand-mist/35"
      : "aspect-[4/3] overflow-hidden bg-brand-mist/35";

  return (
    <div id={galleryId} className={containerClassName}>
      {images.map((image, index) => {
        // Guarantee a non-empty, non-noisy alt even when the source image has
        // no filename (e.g. a base64 data: URI): fall back to a positional
        // label so screen readers can distinguish gallery items (#1947).
        // NOTE: this deliberately overrides even an explicit alt="" (which the
        // data layer preserves as "decorative"). Here each image is the sole
        // content of an <a> lightbox link, so an empty alt would leave the link
        // with no accessible name (WCAG 2.4.4 / 4.1.2). A positional name is the
        // correct trade-off for a linked image; the plain decorative rule only
        // applies to a non-interactive standalone <img>.
        const altText =
          image.alt ||
          (variant === "slideshow"
            ? `Slide ${index + 1}`
            : `Gallery image ${index + 1}`);
        const sources = imageSources(image);
        return (
        <a
          key={`${image.src}-${image.alt}-${index}`}
          href={sources.full.src}
          data-pswp-width={sources.full.width ?? undefined}
          data-pswp-height={sources.full.height ?? undefined}
          className={cardClassName}
        >
          <div className={imageWrapperClassName}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={sources.thumbnailSrc}
              srcSet={sources.srcSet}
              sizes={
                sources.srcSet
                  ? variant === "slideshow"
                    ? SLIDESHOW_IMAGE_SIZES
                    : GALLERY_IMAGE_SIZES
                  : undefined
              }
              alt={altText}
              width={image.width ?? undefined}
              height={image.height ?? undefined}
              className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
              loading="lazy"
            />
          </div>
          {variant !== "slideshow" ? (
            <div className="px-4 py-3 text-sm text-brand-deep/80">
              {image.alt || "Open image"}
            </div>
          ) : null}
        </a>
        );
      })}
    </div>
  );
}
