import { defineHub } from "../define";

/** Website. */
export const WEBSITE_HUB = defineHub({
  key: "website",
  label: "Website",
  prefix: "website",
  pages: [
    {
      id: "appearance",
      label: "Site Appearance & Content",
      oldPath: "/admin/appearance",
      area: "content",
      moved: false,
    },
    {
      id: "club-identity",
      label: "Club Identity",
      oldPath: "/admin/appearance/identity",
      area: "content",
      moved: false,
    },
    {
      id: "site-style",
      label: "Site Style",
      oldPath: "/admin/site-style",
      area: "content",
      moved: false,
    },
    {
      id: "site-content",
      label: "Site Content",
      oldPath: "/admin/site-content",
      area: "content",
      moved: false,
    },
    {
      id: "page-content",
      label: "Page Content",
      oldPath: "/admin/page-content",
      area: "content",
      moved: false,
    },
    {
      id: "site-banners",
      label: "Site Banners",
      oldPath: "/admin/site-banners",
      area: "content",
      moved: false,
    },
    {
      id: "image-manager",
      label: "Image Manager",
      oldPath: "/admin/image-manager",
      area: "content",
      moved: false,
    },
    {
      id: "mountain-conditions",
      label: "Mountain Conditions",
      oldPath: "/admin/mountain-conditions",
      area: "content",
      flags: ["skifieldConditions"],
      moved: false,
    },
  ],
});
