import { readFileSync } from "node:fs";
import { MemberMoneyAccount } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { MEMBER_MONEY_ACCOUNTS } from "@/lib/member-money";
import {
  ACCOUNT_MAPPING_DEFAULTS,
  ACCOUNT_MAPPING_KEYS,
  ACCOUNT_MAPPING_KEYS_ASKING_WHILE_UNSET,
  MAPPING_ACCOUNT_FILTERS,
  MAPPING_LABELS,
  PROPOSED_MEMBER_MONEY_MAPPING_KEYS,
  XERO_MAPPING_WRITABLE_KEYS,
} from "@/lib/xero-account-mapping-keys";

const proposed: readonly string[] = PROPOSED_MEMBER_MONEY_MAPPING_KEYS;

describe("member money chart (#4513)", () => {
  it("names every economic account by a registered or a proposed key, without provider codes", () => {
    expect(Object.keys(MEMBER_MONEY_ACCOUNTS).sort()).toEqual(Object.values(MemberMoneyAccount).sort());
    const named = Object.values(MEMBER_MONEY_ACCOUNTS).map((account) => account.mappingKey as string);
    for (const key of named) {
      expect(ACCOUNT_MAPPING_KEYS.includes(key as never) || proposed.includes(key), key).toBe(true);
    }
    for (const account of Object.values(MEMBER_MONEY_ACCOUNTS)) {
      if ("refundMappingKey" in account) expect(ACCOUNT_MAPPING_KEYS).toContain(account.refundMappingKey);
    }
    // Every proposed key is one the chart actually names: the list is not a parking lot.
    expect([...proposed].sort()).toEqual(named.filter((key) => proposed.includes(key)).sort());
  });

  it("keeps proposed keys out of every settings list derived from the registry", () => {
    const seed = readFileSync("prisma/seed.ts", "utf8");
    for (const key of proposed) {
      expect(ACCOUNT_MAPPING_KEYS, key).not.toContain(key);
      expect(XERO_MAPPING_WRITABLE_KEYS, key).not.toContain(key);
      expect(ACCOUNT_MAPPING_KEYS_ASKING_WHILE_UNSET, key).not.toContain(key);
      expect(Object.keys(MAPPING_LABELS), key).not.toContain(key);
      expect(Object.keys(MAPPING_ACCOUNT_FILTERS), key).not.toContain(key);
      expect(Object.keys(ACCOUNT_MAPPING_DEFAULTS), key).not.toContain(key);
      expect(seed, key).not.toContain(`"${key}"`);
    }
  });

  it("keeps system control accounts on document routes", () => {
    for (const key of ["MEMBER_RECEIVABLE", "MEMBER_CREDIT", "GST_PAYABLE"] as const) {
      expect(MEMBER_MONEY_ACCOUNTS[key].route).toBe("DOCUMENT_CONTROL");
    }
    expect(MEMBER_MONEY_ACCOUNTS.BANK.refundMappingKey).toBe("bankTransferRefundAccount");
  });
});
