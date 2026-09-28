// Barrel for the admin-alert email family (#1210).
//
// This module was split by DOMAIN/source — not by audience — because the alerts
// partition cleanly on their trigger domain, while most fan out to "all admins"
// anyway, so an audience axis (finance vs ops admins) is fuzzy. The sub-modules
// each import shared plumbing from `./admin-alerts-shared`, never each other;
// this barrel only re-exports. Keeping it a barrel preserves the facade
// `src/lib/email.ts` (`export * from "./email/admin-alerts"`) byte-for-byte, so
// every previously-exported symbol (incl. `getAdminEmails`) still resolves.
export * from "./admin-alerts-shared";
export * from "./admin-alerts-booking";
export * from "./admin-alerts-membership";
export * from "./admin-alerts-finance";
export * from "./admin-alerts-late-capture";
export * from "./admin-alerts-settlement";
export * from "./admin-alerts-ops";
export * from "./admin-alerts-internet-banking-started-stay";
