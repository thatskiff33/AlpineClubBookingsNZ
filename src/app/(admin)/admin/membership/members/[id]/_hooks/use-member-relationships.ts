"use client";

import { useState, type Dispatch, type SetStateAction } from "react";
import { toast } from "sonner";

interface UseMemberRelationshipsParams {
  fetchMember: () => Promise<void>;
  setLoading: Dispatch<SetStateAction<boolean>>;
  setRelationshipError: Dispatch<SetStateAction<string>>;
}

export function useMemberRelationships({
  fetchMember,
  setLoading,
  setRelationshipError,
}: UseMemberRelationshipsParams) {
  const [unlinkingDependentId, setUnlinkingDependentId] = useState<
    string | null
  >(null);

  const handleUnlinkDependent = async (
    parentId: string,
    dependentId: string,
    dependentName: string,
  ) => {
    if (!confirm(`Remove the parent/dependant link for ${dependentName}?`))
      return;

    setUnlinkingDependentId(dependentId);
    setRelationshipError("");

    try {
      const res = await fetch(
        `/api/admin/members/${parentId}/dependents/${dependentId}`,
        {
          method: "DELETE",
        },
      );
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(data.error || "Failed to remove parent/dependant link");
      }

      toast.success("Parent/dependant link removed");
      setLoading(true);
      await fetchMember();
    } catch (err) {
      setRelationshipError(
        err instanceof Error
          ? err.message
          : "Failed to remove parent/dependant link",
      );
    } finally {
      setUnlinkingDependentId(null);
    }
  };

  return { unlinkingDependentId, handleUnlinkDependent };
}
