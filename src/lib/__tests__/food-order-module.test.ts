import fs from "fs";
import path from "path";
import { describe, expect, it, vi } from "vitest";

// Registration facts and files only. The proxy reaches the Prisma client at
// module scope, so without these doubles the file dies at import on a checkout
// with no DATABASE_URL.
vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import {
  DEFAULT_MODULE_SETTINGS,
  MODULE_DEFINITIONS,
  MODULE_KEYS,
  getEffectiveModuleFlags,
} from "@/config/modules";
import {
  getRequiredFeaturesForPath,
  isFeatureHrefVisible,
} from "@/config/feature-routes";
import type { FeatureFlags } from "@/config/schema";
import { config as proxyConfig } from "@/proxy";

/**
 * Fork #121: the `foodOrders` module, its route gate and its migration.
 *
 * Off by default (fork #121 owner decision 14): an order goes to the food officer's
 * email, and until the committee enters one there is nobody to send it to.
 * While it is off every food-order page and API is gated to 404 and the admin
 * settings page and its sidebar link disappear; the route handlers' own
 * re-check is proved in `food-order-routes.test.ts` and
 * `food-order-settings-route.test.ts`, the dashboard card in the dashboard
 * suite.
 */

const MIGRATION = "20261211030000_add_food_orders";

function flags(foodOrders: boolean): FeatureFlags {
  return { ...getEffectiveModuleFlags(DEFAULT_MODULE_SETTINGS), foodOrders };
}

describe("foodOrders module registration", () => {
  it("is listed in the module registry with a card", () => {
    expect(MODULE_KEYS).toContain("foodOrders");
    expect(MODULE_DEFINITIONS.foodOrders.key).toBe("foodOrders");
    expect(MODULE_DEFINITIONS.foodOrders.label).toBe("Food orders");
  });

  it("defaults OFF, in the config and in the schema", () => {
    expect(DEFAULT_MODULE_SETTINGS.foodOrders).toBe(false);
    expect(getEffectiveModuleFlags(DEFAULT_MODULE_SETTINGS).foodOrders).toBe(false);
    const schema = fs.readFileSync(path.join(process.cwd(), "prisma", "schema.prisma"), "utf8");
    expect(schema).toMatch(/foodOrders\s+Boolean\s+@default\(false\)/);
  });

  it("tells an admin on the card that the food officer email comes first and nothing is charged", () => {
    const text = [
      MODULE_DEFINITIONS.foodOrders.description,
      ...MODULE_DEFINITIONS.foodOrders.dependencies,
    ].join(" ");
    expect(text).toMatch(/email address/i);
    expect(text).toMatch(/never charged|nothing is charged/i);
  });
});

describe("foodOrders route gate", () => {
  const gated = [
    "/food-order",
    "/food-orders",
    "/api/food-orders",
    "/api/food-orders/history",
    "/api/food-orders/abc/received",
    "/api/food-orders/abc/price",
    "/api/admin/food-orders/settings",
    "/admin/food-orders",
  ];

  for (const pathname of gated) {
    it(`${pathname} needs the module`, () => {
      expect(getRequiredFeaturesForPath(pathname)).toContain("foodOrders");
    });
  }

  it("hides the admin page link and the member links while off, and shows them while on", () => {
    for (const href of ["/admin/food-orders", "/food-order", "/food-orders"]) {
      expect(isFeatureHrefVisible(href, flags(false))).toBe(false);
      expect(isFeatureHrefVisible(href, flags(true))).toBe(true);
    }
  });

  it("does not gate unrelated neighbours", () => {
    expect(getRequiredFeaturesForPath("/food")).not.toContain("foodOrders");
    expect(getRequiredFeaturesForPath("/maintenance-report")).not.toContain("foodOrders");
  });

  it("is reachable by the proxy for the member API", () => {
    // The proxy's first matcher entry skips every /api path, so without this
    // entry the gate never runs in front of the member API.
    expect(proxyConfig.matcher).toContain("/api/food-orders/:path*");
  });
});

describe("foodOrders member pages gate themselves", () => {
  // Both pages re-check the module on the server, so the 404 does not live only
  // in the proxy (#2780). Read as source: rendering them needs the whole app.
  for (const page of ["food-order", "food-orders"]) {
    it(`/${page} calls notFound() when the module is off`, () => {
      const source = fs.readFileSync(
        path.join(process.cwd(), "src", "app", "(authenticated)", page, "page.tsx"),
        "utf8",
      );
      expect(source).not.toMatch(/^"use client"/);
      expect(source).toMatch(/if \(!modules\.foodOrders\) notFound\(\);/);
    });
  }
});

describe("foodOrders migration", () => {
  const sql = fs.readFileSync(
    path.join(process.cwd(), "prisma", "migrations", MIGRATION, "migration.sql"),
    "utf8",
  );

  it("is expand-only, as its ledger row claims", () => {
    expect(sql).not.toMatch(
      /(^|[^A-Z_])(DROP TABLE|DROP COLUMN|DROP TYPE|DROP CONSTRAINT|RENAME COLUMN|ALTER COLUMN .* TYPE|ALTER COLUMN .* SET NOT NULL)/im,
    );
  });

  it("carries no DML", () => {
    expect(sql).not.toMatch(/^\s*(INSERT|UPDATE|DELETE)\b/im);
  });

  it("adds the module flag with a constant default so an old-colour insert still works", () => {
    expect(sql).toMatch(/ADD COLUMN\s+"foodOrders"\s+BOOLEAN\s+NOT NULL\s+DEFAULT false/i);
  });

  it("backs the item and price rules with CHECK constraints", () => {
    expect(sql).toMatch(/CHECK \("quantity" > 0 AND "quantity" <= 99999\.99\)/);
    expect(sql).toMatch(/"quantity" DECIMAL\(7,2\) NOT NULL/);
    expect(sql).toMatch(/"unit" "FoodOrderUnit" NOT NULL DEFAULT 'ITEMS'/);
    expect(sql).toMatch(/CHECK \("priceCents" IS NULL OR "priceCents" >= 0\)/);
  });

  it("has a ledger row declaring it old-code compatible", () => {
    const ledger = fs.readFileSync(
      path.join(process.cwd(), "docs", "BLUE_GREEN_MIGRATION_SAFETY.tsv"),
      "utf8",
    );
    const row = ledger.split("\n").find((line) => line.startsWith(`${MIGRATION}\t`));
    expect(row).toBeDefined();
    const [, phase, , compatible, notes] = row!.split("\t");
    expect(phase).toBe("expand");
    expect(compatible).toBe("yes");
    expect(notes).toMatch(/TIMESTAMP COORDINATION/);
  });
});
