/** Every namespace the encrypted credential store accepts, including system writers. */
export const INTEGRATION_CREDENTIAL_NAMESPACES = [
  "xero",
  "xero-oauth",
  "stripe",
  "google",
  "backup",
  "anthropic",
  "anthropic-diagnostics",
  "servernz",
  "mirotalk",
] as const;

export type IntegrationCredentialNamespace = (typeof INTEGRATION_CREDENTIAL_NAMESPACES)[number];

/** Narrow untrusted request input or a database string before entering the store. */
export function isIntegrationCredentialNamespace(value: unknown): value is IntegrationCredentialNamespace {
  return typeof value === "string"
    && INTEGRATION_CREDENTIAL_NAMESPACES.some((namespace) => namespace === value);
}
