import { defineHub } from "../define";

/** Home: the dashboard is the hub's own root, so it never moves. */
export const DASHBOARD_HUB = defineHub({
  key: "dashboard",
  label: "Home",
  prefix: "dashboard",
  pages: [
    {
      id: "dashboard",
      label: "Admin Dashboard",
      oldPath: "/admin/dashboard",
      area: "overview",
      landing: true,
      moved: false,
    },
  ],
});
