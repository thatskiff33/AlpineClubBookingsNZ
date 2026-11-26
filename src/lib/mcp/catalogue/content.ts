/**
 * The Content admin area's AI app actions (ALP-723, `INV-MCP-006`).
 *
 * Each runs on an `/api/admin` route that `getAdminRouteRequirement` gives to
 * the `content` area, with the officer's real permissions, so an officer
 * without the area is never offered one and its route refuses one anyway.
 * Like every officer action it is offered only on a connection the officer
 * approved for officer actions (`officer-actions.ts`, `INV-MCP-009`). The
 * area's file uploads have a permanent reason in `exclusions.ts`.
 */
import type { McpAction } from "../catalogue";

import { CONTENT_IMAGE_MCP_ACTIONS } from "./content-images";
import { CONTENT_PAGE_MCP_ACTIONS } from "./content-pages";
import { CONTENT_SETTINGS_MCP_ACTIONS } from "./content-settings";

export const CONTENT_MCP_ACTIONS: readonly McpAction[] = [
  ...CONTENT_PAGE_MCP_ACTIONS,
  ...CONTENT_SETTINGS_MCP_ACTIONS,
  ...CONTENT_IMAGE_MCP_ACTIONS,
];
