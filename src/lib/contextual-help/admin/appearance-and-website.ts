/**
 * Help for the Appearance hub and the public-website pages it leads to: site
 * style, page content, banners, site content, mountain conditions and the image
 * manager.
 *
 * Split out of "Setup & Configuration" rather than invented: `/admin/appearance`
 * is the hub the sidebar links, and every page here is one of its cards. Kept
 * separate because the settings section would otherwise be half the corpus.
 *
 * The keys stay the pages' OLD paths now that the pages live under
 * `/admin/website` (C4 #4801), and must not become `adminHref`: the admin help
 * widget looks a page up by `canonicalAdminPathname`, which reads a moved page's
 * hub URL as its old path, in either switch state.
 */
import { entry, help, type HelpEntry } from "../types";

export const adminAppearanceAndWebsiteHelpEntries: HelpEntry[] = [
  entry(
    "/admin/appearance",
    help(
      "Site Appearance & Content",
      "Site Appearance & Content groups public-facing style, content, banner, media, and mountain-condition setup.",
      [
        "Open Site Style before changing shared theme, logo, colour, or font settings.",
        "Use Page Content, Site Content, and Site Banners for public copy and notice changes.",
        "Use Image Manager and Mountain Conditions only for reviewed public-media or module-backed content updates.",
      ],
      [
        {
          name: "Site Style",
          description:
            "Public theme, logo, colours, fonts, and first-run style completion.",
        },
        {
          name: "Content pages",
          description:
            "Page content, shared site chrome, public banners, and reusable public text.",
        },
        {
          name: "Media",
          description:
            "Filesystem images and module-backed mountain-condition content used by public pages.",
        },
      ],
    ),
  ),
  entry(
    "/admin/site-style",
    help(
      "Site Style",
      "Site Style controls the public website theme, colours, fonts, logo, and page-level style rules.",
      [
        "Complete required style fields before opening the public website.",
        "Upload or choose branding assets with appropriate alt text.",
        "Use custom CSS only for reviewed public-page styling changes.",
      ],
      [
        {
          name: "Logo",
          description:
            "The database-stored public logo used by website chrome.",
        },
        {
          name: "Colours and fonts",
          description:
            "Theme values applied to public website pages.",
        },
        {
          name: "Custom CSS",
          description:
            "Reviewed style rules for specific public page presentation.",
        },
      ],
    ),
  ),
  entry(
    "/admin/page-content",
    help(
      "Page Content",
      "Page Content creates and edits routable public website pages and their menu settings.",
      [
        "Use Add Page for new public pages and Edit for existing pages.",
        "Set slug, menu title/order, header content, body HTML, and publish state deliberately.",
        "Use token help and the image picker when inserting supported dynamic content.",
      ],
      [
        {
          name: "Slug",
          description:
            "The unique URL segment for the public page.",
        },
        {
          name: "Menu title and order",
          description:
            "Controls whether and where the page appears in public navigation.",
        },
        {
          name: "Body",
          description:
            "Sanitised rich HTML displayed on the page.",
        },
      ],
      [
        "Scripts and unsafe HTML are removed on save and render.",
      ],
    ),
  ),
  entry(
    "/admin/site-banners",
    help(
      "Site Banners",
      "Site Banners publishes plain-text public notices above the website and member headers for a date window.",
      [
        "Create a banner with message, priority, start date, end date, and active state.",
        "Use priority to communicate urgency: urgent, warning, or notify.",
        "Edit a banner when wording changes; visitors who dismissed the old wording will see the updated banner again.",
      ],
      [
        {
          name: "Priority",
          description:
            "Controls the faded red, amber, or blue styling and announcement role.",
        },
        {
          name: "Display window",
          description:
            "Inclusive New Zealand date-only start and end dates.",
        },
        {
          name: "Active",
          description:
            "Controls whether the banner can show during its display window.",
        },
      ],
    ),
  ),
  entry(
    "/admin/site-content",
    help(
      "Site Content",
      "Site Content edits shared public website chrome that is not a standalone page, such as footer columns.",
      [
        "Open the section you need and save one shared content block at a time.",
        "Use supported text tokens for live club values.",
        "Clear optional footer columns only when they should disappear from the public footer.",
      ],
      [
        {
          name: "Section",
          description:
            "The shared content block being edited, such as footer blurb or quick links.",
        },
        {
          name: "HTML",
          description:
            "Sanitised rich content rendered in shared website chrome.",
        },
        {
          name: "Tokens",
          description:
            "Supported placeholders such as club name, currency, lodge capacity, or Facebook URL.",
        },
      ],
    ),
  ),
  entry(
    "/admin/mountain-conditions",
    help(
      "Mountain Conditions",
      "Mountain Conditions manages public or operational condition information for ski field and lodge visitors.",
      [
        "Review current conditions before publishing updates.",
        "Update wording, severity, or visibility when mountain or access conditions change.",
        "Coordinate urgent operational warnings with Site Banners when visitors need immediate notice.",
      ],
      [
        {
          name: "Condition",
          description:
            "The latest status or description shown to visitors or operators.",
        },
        {
          name: "Visibility",
          description:
            "Controls whether the condition information is displayed.",
        },
      ],
    ),
  ),
  entry(
    "/admin/image-manager",
    help(
      "Image Manager",
      "Image Manager uploads and organises filesystem-backed public images used by public website content.",
      [
        "Choose the correct directory before uploading.",
        "Use descriptive filenames and alt text where the workflow supports it.",
        "Delete only images that are no longer referenced by public content.",
      ],
      [
        {
          name: "Directory",
          description:
            "The public image folder or grouping where the file will be stored.",
        },
        {
          name: "Image file",
          description:
            "A PNG, JPEG, GIF, WebP, or AVIF file within the configured size limit.",
        },
        {
          name: "Public path",
          description:
            "The URL path used by public pages or rich-text image insertion.",
        },
      ],
    ),
  ),
];
