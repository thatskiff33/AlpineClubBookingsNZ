"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type {
  DisplayWizardContext,
  DisplayWizardDevice,
  DisplayWizardLodge,
  DisplayWizardLodgeConfig,
  DisplayWizardTemplate,
} from "./display-wizard-state";

/**
 * Derives the Lodge Display wizard's server truth (#2249).
 *
 * NO new backend surface: it reads the four routes the display admin pages
 * already use — templates, devices, lodges and the per-lodge display config —
 * and takes the `lobbyDisplay` module flag from the page's server render (the
 * modules API is `support`-gated, and a lodge-area admin must still be able to
 * run this wizard, so the flag is passed down rather than fetched).
 *
 * While the module is OFF the display routes 404 the whole `/api/admin/display`
 * tree. The wizard page itself is exempt from that gate so step 1 can turn the
 * module on, which means an all-404 read is an EXPECTED state here, surfaced as
 * `moduleBlockedReads` rather than reported as a failure.
 */

const TEMPLATES_ENDPOINT = "/api/admin/display/templates";
const DEVICES_ENDPOINT = "/api/admin/display/devices";
const LODGES_ENDPOINT = "/api/admin/lodges";
const LODGE_CONFIG_ENDPOINT = "/api/admin/display/lodge-config";

interface RawLodge {
  id: string;
  name: string;
  active?: boolean;
}

/**
 * Split the saved `displayConfig` into the text values the quick-set can edit
 * and the keys it cannot represent.
 *
 * The column is JSON, so a hand-edited or imported row can hold a number, a
 * list or an object. The lodge-config route accepts string values ONLY (it 400s
 * anything else) and replaces the whole object on every write, so a
 * non-text value cannot survive a save from this step whichever way it is
 * handled: re-posting it verbatim is refused, and leaving it out deletes it.
 *
 * They are therefore neither coerced nor silently dropped — they are counted
 * and named, so the step can warn before the operator saves (#2249 review L7).
 */
function splitConfigRecord(value: unknown): {
  text: Record<string, string>;
  unrepresentableKeys: string[];
} {
  if (!value || typeof value !== "object") {
    return { text: {}, unrepresentableKeys: [] };
  }
  const text: Record<string, string> = {};
  const unrepresentableKeys: string[] = [];
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === "string") text[key] = raw;
    else unrepresentableKeys.push(key);
  }
  return { text, unrepresentableKeys: unrepresentableKeys.sort() };
}

export interface DisplayWizardContextResult {
  context: DisplayWizardContext;
  loading: boolean;
  /** Re-read every source, including the server-rendered module flag. */
  refresh: () => void;
  /** Change which lodge the wizard is setting up. */
  selectLodge: (lodgeId: string) => void;
}

export function useDisplayWizardContext(
  moduleEnabled: boolean,
): DisplayWizardContextResult {
  const router = useRouter();
  const [templates, setTemplates] = useState<DisplayWizardTemplate[]>([]);
  const [devices, setDevices] = useState<DisplayWizardDevice[]>([]);
  const [lodges, setLodges] = useState<DisplayWizardLodge[]>([]);
  const [lodgeId, setLodgeId] = useState<string | null>(null);
  const lodgeIdRef = useRef<string | null>(null);
  const [lodgeConfig, setLodgeConfig] =
    useState<DisplayWizardLodgeConfig | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [moduleBlockedReads, setModuleBlockedReads] = useState(false);

  const loadLists = useCallback(async () => {
    const [templatesRes, devicesRes, lodgesRes] = await Promise.all([
      fetch(TEMPLATES_ENDPOINT, { cache: "no-store" }).catch(() => null),
      fetch(DEVICES_ENDPOINT, { cache: "no-store" }).catch(() => null),
      fetch(LODGES_ENDPOINT, { cache: "no-store" }).catch(() => null),
    ]);

    // A 404 from the display routes is the module gate, not a missing route.
    setModuleBlockedReads(
      templatesRes?.status === 404 || devicesRes?.status === 404,
    );

    if (templatesRes?.ok) {
      const body = (await templatesRes.json().catch(() => null)) as {
        templates?: DisplayWizardTemplate[];
      } | null;
      setTemplates(body?.templates ?? []);
    } else {
      setTemplates([]);
    }

    if (devicesRes?.ok) {
      const body = (await devicesRes.json().catch(() => null)) as {
        devices?: DisplayWizardDevice[];
      } | null;
      setDevices(body?.devices ?? []);
    } else {
      setDevices([]);
    }

    let nextLodgeId: string | null = null;
    if (lodgesRes?.ok) {
      const body = (await lodgesRes.json().catch(() => null)) as {
        lodges?: RawLodge[];
      } | null;
      const active = (body?.lodges ?? []).filter(
        (lodge) => lodge.active !== false,
      );
      setLodges(active.map((lodge) => ({ id: lodge.id, name: lodge.name })));
      nextLodgeId = active[0]?.id ?? null;
    }
    return nextLodgeId;
  }, []);

  const loadLodgeConfig = useCallback(async (targetLodgeId: string | null) => {
    const url = targetLodgeId
      ? `${LODGE_CONFIG_ENDPOINT}?lodgeId=${encodeURIComponent(targetLodgeId)}`
      : LODGE_CONFIG_ENDPOINT;
    const res = await fetch(url, { cache: "no-store" }).catch(() => null);
    if (!res?.ok) {
      setLodgeConfig(null);
      return;
    }
    const body = (await res.json().catch(() => null)) as {
      lodgeId?: string;
      lodgeName?: string;
      displayConfig?: unknown;
      displayNotice?: string | null;
    } | null;
    if (!body?.lodgeId) {
      setLodgeConfig(null);
      return;
    }
    const config = splitConfigRecord(body.displayConfig);
    setLodgeConfig({
      lodgeId: body.lodgeId,
      lodgeName: body.lodgeName ?? "",
      displayConfig: config.text,
      unrepresentableConfigKeys: config.unrepresentableKeys,
      displayNotice: body.displayNotice ?? null,
    });
  }, []);

  const load = useCallback(async () => {
    const defaultLodgeId = await loadLists();
    // Keep an explicit lodge choice; otherwise adopt the first active lodge so
    // the config + pairing steps have a subject on first load. The choice is
    // mirrored in a ref because a state updater must stay pure — reading it
    // there to decide what to fetch would run twice under StrictMode.
    const target = lodgeIdRef.current ?? defaultLodgeId;
    lodgeIdRef.current = target;
    setLodgeId(target);
    await loadLodgeConfig(target);
    setLoaded(true);
    setLoading(false);
  }, [loadLists, loadLodgeConfig]);

  useEffect(() => {
    void load();
  }, [load]);

  const refresh = useCallback(() => {
    // `router.refresh()` re-runs the page's server render, which is where the
    // module flag comes from — without it, step 1 would stay "off" after the
    // operator turned the module on.
    router.refresh();
    void load();
  }, [load, router]);

  const selectLodge = useCallback(
    (nextLodgeId: string) => {
      lodgeIdRef.current = nextLodgeId;
      setLodgeId(nextLodgeId);
      void loadLodgeConfig(nextLodgeId);
    },
    [loadLodgeConfig],
  );

  const context: DisplayWizardContext = {
    moduleEnabled,
    templates,
    devices,
    lodges,
    lodgeId,
    lodgeConfig,
    loaded,
    moduleBlockedReads,
  };

  return { context, loading, refresh, selectLodge };
}
