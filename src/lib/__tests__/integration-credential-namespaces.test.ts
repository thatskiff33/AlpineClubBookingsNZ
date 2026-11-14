import { describe, expect, expectTypeOf, it } from "vitest";
import {
  INTEGRATION_CREDENTIAL_NAMESPACES,
  isIntegrationCredentialNamespace,
  type IntegrationCredentialNamespace,
} from "@/lib/integration-credential-namespaces";
import type {
  SetIntegrationCredentialParams,
  DeleteIntegrationCredentialParams,
  resolveIntegrationCredential,
  withCredentialTransaction,
} from "@/lib/integration-credentials";

// These assertions are checked by tsc as well as documenting the public API.
expectTypeOf<SetIntegrationCredentialParams["provider"]>().toEqualTypeOf<IntegrationCredentialNamespace>();
expectTypeOf<DeleteIntegrationCredentialParams["provider"]>().toEqualTypeOf<IntegrationCredentialNamespace>();
expectTypeOf<Parameters<typeof resolveIntegrationCredential>[0]>().toEqualTypeOf<IntegrationCredentialNamespace>();
expectTypeOf<Parameters<typeof withCredentialTransaction>[0]>().toEqualTypeOf<readonly IntegrationCredentialNamespace[]>();
// @ts-expect-error Unregistered provider names cannot be stored.
const unregistered: IntegrationCredentialNamespace = "unregistered-provider";
void unregistered;

describe("integration credential namespaces", () => {
  it("includes the nine namespaces in use, including system-managed stores", () => {
    expect(INTEGRATION_CREDENTIAL_NAMESPACES).toHaveLength(9);
    expect(new Set(INTEGRATION_CREDENTIAL_NAMESPACES).size).toBe(9);
    expect(isIntegrationCredentialNamespace("mirotalk")).toBe(true);
    expect(isIntegrationCredentialNamespace("xero-oauth")).toBe(true);
  });

  it("narrows request input and refuses unknown or prototype property names", () => {
    for (const provider of INTEGRATION_CREDENTIAL_NAMESPACES) expect(isIntegrationCredentialNamespace(provider)).toBe(true);
    for (const input of ["unknown", "toString", "__proto__", "", null, 42, {}]) expect(isIntegrationCredentialNamespace(input)).toBe(false);
    const input: unknown = "xero";
    if (isIntegrationCredentialNamespace(input)) expectTypeOf(input).toEqualTypeOf<IntegrationCredentialNamespace>();
  });
});
