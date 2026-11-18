// Plain-English lines for the environment role step of the setup readiness
// report. The step itself is built in `setup-readiness.ts`.
import type { EnvironmentRoleResolution } from "@/lib/environment-role";
import type { EnvironmentRoleDeclaration } from "@/lib/environment-role-declaration";

/**
 * Plain-English state of the deployment declaration, for the readiness details.
 *
 * The raw value in the `invalid` case has ALREADY been stripped of control
 * characters and capped by `sanitizeEnvironmentRoleRawValue`, which is why it can
 * be quoted straight into a line that ends up in an operator's terminal.
 */
export function describeEnvironmentRoleDeclaration(
  declaration: EnvironmentRoleDeclaration,
): string {
  switch (declaration.kind) {
    case "production":
      return "Deployment declaration: APP_ENVIRONMENT_ROLE=production.";
    case "non-production":
      return "Deployment declaration: APP_ENVIRONMENT_ROLE=non-production.";
    case "invalid":
      return `Deployment declaration: APP_ENVIRONMENT_ROLE is set to "${declaration.raw}", which is not one of the two accepted values (production, non-production), so it is refused rather than guessed at.`;
    case "absent":
      return "Deployment declaration: APP_ENVIRONMENT_ROLE is not set.";
  }
}

/** Plain-English state of the database safer override. */
export function describeEnvironmentRoleOverride(
  resolution: EnvironmentRoleResolution,
): string {
  switch (resolution.databaseOverride.kind) {
    case "force-non-production":
      return "Safer override: ON — an administrator has forced this installation to behave as non-production. It can be switched off at /admin/environment, which hands the decision back to the deployment declaration and never makes an installation production on its own.";
    case "none":
      return "Safer override: off — nothing in the database is forcing this installation to be treated as non-production.";
    case "unreadable":
      return "Safer override: could not be read. The EnvironmentSafetySettings table is most likely missing because the migration has not been applied on this database yet — run prisma migrate deploy (or pnpm run db:migrate in development), then check again.";
  }
}
