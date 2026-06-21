"use client";

import { useEffect } from "react";
import PhotoSwipeLightbox from "photoswipe/lightbox";
import "photoswipe/style.css";

type PhotoGalleryImage = {
  src: string;
  alt: string;
  width: number | null;
  height: number | null;
};

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
      pswpModule: () => import("photoswipe"),
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
              thumbnail.src = image.src;
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

    let autoOpenFrame: number | undefined;
    if (variant === "slideshow") {
      autoOpenFrame = window.requestAnimationFrame(() => {
        if (!lightbox.pswp) {
          lightbox.loadAndOpen(0, { gallery: galleryElement });
        }
      });
    }

    return () => {
      if (autoOpenFrame !== undefined) {
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
      ? "group snap-start overflow-hidden rounded-3xl border border-brand-ridge/20 bg-white shadow-sm transition-transform duration-200 hover:-translate-y-1 hover:shadow-lg"
      : "group overflow-hidden rounded-3xl border border-brand-ridge/20 bg-white shadow-sm transition-transform duration-200 hover:-translate-y-1 hover:shadow-lg";

  const imageWrapperClassName =
    variant === "slideshow"
      ? "aspect-[16/10] overflow-hidden bg-brand-mist/35"
      : "aspect-[4/3] overflow-hidden bg-brand-mist/35";

  return (
    <div id={galleryId} className={containerClassName}>
      {images.map((image) => (
        <a
          key={`${image.src}-${image.alt}`}
          href={image.src}
          data-pswp-width={image.width ?? undefined}
          data-pswp-height={image.height ?? undefined}
          className={cardClassName}
        >
          <div className={imageWrapperClassName}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={image.src}
              alt={image.alt}
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
      ))}
    </div>
  );
}
