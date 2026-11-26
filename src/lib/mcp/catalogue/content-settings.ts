/**
 * Site settings, site style and mountain conditions (Content admin area,
 * ALP-723): what an officer sets on Admin → Website → Club identity, Public
 * content, Privacy, Site style and Mountain conditions. Each save replaces a
 * club-wide setting the public website shows at once, so each is
 * `destructive` (owner rule, #5305).
 */
import {
  mountainConditionsReportSchema,
  mountainConditionsUpdateSchema,
} from "@/lib/admin-content-api/mountain-conditions";
import {
  clubContactSchema,
  clubIdentitySchema,
  publicContentSettingsConnectionSchema,
} from "@/lib/admin-content-api/settings";
import { clubThemeConnectionUpdateSchema } from "@/lib/club-theme-update-schema";
import {
  CLUB_CONTACT_READ_CONNECTION_SHAPE,
  CLUB_CONTACT_SAVED_CONNECTION_SHAPE,
  CLUB_IDENTITY_CONNECTION_SHAPE,
  MOUNTAIN_CONDITIONS_READ_CONNECTION_SHAPE,
  MOUNTAIN_CONDITIONS_SAVED_CONNECTION_SHAPE,
  PRIVACY_HOSTING_CONNECTION_SHAPE,
  PUBLIC_CONTENT_SETTINGS_READ_CONNECTION_SHAPE,
  PUBLIC_CONTENT_SETTINGS_SAVED_CONNECTION_SHAPE,
  SITE_STYLE_CONNECTION_SHAPE,
} from "@/lib/connection-shapes/content-settings";
import { privacyHostingSchema } from "@/lib/privacy-hosting";

import type { McpAction } from "../catalogue";

export const CONTENT_SETTINGS_MCP_ACTIONS: readonly McpAction[] = [
  // --- Club identity and the Contact page -------------------------------------
  {
    id: "get_club_identity",
    title: "Show the club's identity settings",
    summary:
      "The club's name, short name, hut leader label and Facebook address as the website shows them, and the legal name and postal address its booking invoices print. Null means the built-in default is used.",
    method: "GET",
    path: "/api/admin/club-identity",
    kind: "read",
    returns: CLUB_IDENTITY_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "update_club_identity",
    title: "Change the club's identity settings",
    summary:
      "Replaces the club's name, short name, hut leader label and Facebook address together (send all four; blank or null restores the default), and the invoice legal name and postal address if sent. Read them with `get_club_identity` first.",
    method: "PUT",
    path: "/api/admin/club-identity",
    body: clubIdentitySchema,
    kind: "destructive",
    returns: CLUB_IDENTITY_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "get_contact_page_role",
    title: "Show whose details the Contact page gives",
    summary:
      "Which committee role's holders the public Contact page lists (`contactCommitteeRoleKey`; null means the booking officer), and the active roles to choose from.",
    method: "GET",
    path: "/api/admin/club-contact",
    kind: "read",
    returns: CLUB_CONTACT_READ_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "set_contact_page_role",
    title: "Choose whose details the Contact page gives",
    summary:
      "Sets the committee role whose holders the public Contact page lists, by `key` from `get_contact_page_role`; null goes back to the booking officer.",
    method: "PUT",
    path: "/api/admin/club-contact",
    body: clubContactSchema,
    kind: "destructive",
    returns: CLUB_CONTACT_SAVED_CONNECTION_SHAPE,
    core: false,
  },

  // --- Public fee and policy sections, and the privacy page -------------------
  {
    id: "get_public_content_settings",
    title: "Show which fee and policy sections the website shows",
    summary:
      "Which fee and policy sections the public pages show, where the Book Now button goes, how committee photos are shown, and the published pages Book Now may point at.",
    method: "GET",
    path: "/api/admin/public-content-settings",
    kind: "read",
    returns: PUBLIC_CONTENT_SETTINGS_READ_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "update_public_content_settings",
    title: "Change which fee and policy sections the website shows",
    summary:
      "Replaces every setting at once except how committee photos are shown, which an officer changes on the website: read them with `get_public_content_settings` and send all back without `committeePhotoDisplay`. With `bookNowTarget` `PAGE`, `bookNowPageId` must be a published page.",
    method: "PUT",
    path: "/api/admin/public-content-settings",
    body: publicContentSettingsConnectionSchema,
    kind: "destructive",
    returns: PUBLIC_CONTENT_SETTINGS_SAVED_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "get_privacy_hosting_disclosure",
    title: "Show the privacy page's hosting details",
    summary:
      "The hosting company and the country where members' information is held, as the privacy page names them. Null means not given.",
    method: "GET",
    path: "/api/admin/privacy-hosting",
    kind: "read",
    returns: PRIVACY_HOSTING_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "update_privacy_hosting_disclosure",
    title: "Change the privacy page's hosting details",
    summary:
      "Sets both hosting details the privacy page states (one line of plain text each; blank or null leaves one unstated). Use only what the club has confirmed with its provider.",
    method: "PUT",
    path: "/api/admin/privacy-hosting",
    body: privacyHostingSchema,
    kind: "destructive",
    returns: PRIVACY_HOSTING_CONNECTION_SHAPE,
    core: false,
  },

  // --- Site style --------------------------------------------------------------
  {
    id: "get_site_style",
    title: "Show the website's style",
    summary:
      "The website's three brand colours, heading and body fonts, custom CSS, which uploaded logo is in use, whether setup is complete, and any colour contrast warnings.",
    method: "GET",
    path: "/api/admin/site-style",
    kind: "read",
    returns: SITE_STYLE_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "update_site_style",
    title: "Change the website's style",
    summary:
      "Replaces the brand colours (6-digit hex), fonts and custom CSS together, across the website and its emails: read them with `get_site_style` and send every field back, `rawCss` included (\"\" clears it). The logo is never changed; changing it, and finishing setup, stay on the website.",
    method: "PUT",
    path: "/api/admin/site-style",
    body: clubThemeConnectionUpdateSchema,
    kind: "destructive",
    returns: SITE_STYLE_CONNECTION_SHAPE,
    core: false,
  },

  // --- Mountain conditions -----------------------------------------------------
  {
    id: "get_mountain_conditions_report",
    title: "Show the stored mountain conditions report",
    summary:
      "The ski field report the public widget shows, as stored: each section, which sections are shown, where it is read from, when it was fetched, and until when auto refresh is paused (`frozenUntil`). Null until first fetched.",
    method: "GET",
    path: "/api/admin/mountain-conditions",
    kind: "read",
    returns: MOUNTAIN_CONDITIONS_READ_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "refresh_mountain_conditions_report",
    title: "Refresh the mountain conditions report",
    summary:
      "Fetches the report from its source now and replaces the stored one, including one saved by hand, and ends any pause on auto refresh. Which sections are shown is kept.",
    method: "POST",
    path: "/api/admin/mountain-conditions",
    kind: "destructive",
    returns: MOUNTAIN_CONDITIONS_SAVED_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "replace_mountain_conditions_report",
    title: "Save a mountain conditions report by hand",
    summary:
      "Replaces the stored report with `rawJson`, the whole report as JSON text in the shape `get_mountain_conditions_report` returns as `payload`, and pauses auto refresh for 12 hours. Which sections show comes from the report's own `visibility`: left out, every section shows again.",
    method: "PUT",
    path: "/api/admin/mountain-conditions",
    body: mountainConditionsReportSchema,
    kind: "destructive",
    returns: MOUNTAIN_CONDITIONS_SAVED_CONNECTION_SHAPE,
    core: false,
  },
  {
    id: "update_mountain_conditions_settings",
    title: "Change the mountain conditions widget",
    summary:
      "Send `visibility` to choose which sections the public widget shows (a section left out is shown), or `config` to change the report's source address (an https address on an allowed ski field site) and selectors. With both, only `config` is saved.",
    method: "PATCH",
    path: "/api/admin/mountain-conditions",
    body: mountainConditionsUpdateSchema,
    kind: "destructive",
    returns: MOUNTAIN_CONDITIONS_SAVED_CONNECTION_SHAPE,
    core: false,
  },
];
