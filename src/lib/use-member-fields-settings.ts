"use client";

import { useEffect, useState } from "react";
import {
  DEFAULT_MEMBER_FIELDS_SETTINGS,
  type MemberFieldsSettingsValues,
} from "@/config/member-fields";

/**
 * Client hook returning the optional member-field visibility flags
 * (showTitle/showGender/showOccupation). Used by the admin member dialogs to
 * hide fields the club has turned off. Defaults to all-on until loaded and on
 * any fetch failure, so the UI degrades to showing fields rather than hiding
 * them unexpectedly. The endpoint is admin-guarded; these dialogs are admin-only.
 */
export function useMemberFieldsSettings(): MemberFieldsSettingsValues {
  const [settings, setSettings] = useState<MemberFieldsSettingsValues>(
    DEFAULT_MEMBER_FIELDS_SETTINGS,
  );

  useEffect(() => {
    let active = true;
    fetch("/api/admin/member-fields", { credentials: "same-origin" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (active && data?.settings) {
          setSettings(data.settings as MemberFieldsSettingsValues);
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  return settings;
}
