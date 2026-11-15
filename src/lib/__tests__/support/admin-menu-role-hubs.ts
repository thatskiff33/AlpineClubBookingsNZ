/**
 * The hubs each seeded admin role's menu shows, by hub label (epic #4468, C14
 * #4811), before a club edits any definition. Full Admin (`ADMIN`) is the
 * hardcoded bundle, not a definition.
 *
 * One table for the two places that pin it: `admin-menu-role.test.ts` proves
 * `resolveAdminMenu` gives each role this list, and `e2e/admin-hubs.spec.ts`
 * proves the sidebar a signed-in officer sees links exactly these hubs. Neither
 * recomputes it.
 */
export const SEEDED_ROLE_HUB_LABELS: Readonly<Record<string, readonly string[]>> = {
  ADMIN: [
    "Home",
    "Bookings",
    "Fees & booking rules",
    "Finance",
    "Members",
    "Lodge",
    "Website",
    "Messages & email",
    "Help & system",
    "Club settings",
  ],
  ADMIN_READONLY: [
    "Home",
    "Bookings",
    "Fees & booking rules",
    "Finance",
    "Members",
    "Lodge",
    "Website",
    "Messages & email",
    "Help & system",
    "Club settings",
  ],
  ADMIN_BOOKINGS: ["Home", "Bookings", "Fees & booking rules", "Lodge"],
  ADMIN_MEMBERSHIP: ["Home", "Members", "Lodge", "Messages & email"],
  ADMIN_CONTENT: ["Home", "Website"],
  FINANCE_ADMIN: ["Home", "Fees & booking rules", "Finance", "Club settings"],
  FINANCE_USER: ["Fees & booking rules", "Finance", "Club settings"],
};
