"use client";

import { useEffect, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { MemberOption } from "@/lib/admin-family-group-ui-helpers";

export interface FamilyGroupMemberPicker {
  memberSearch: string;
  setMemberSearch: Dispatch<SetStateAction<string>>;
  searchResults: MemberOption[];
  setSearchResults: Dispatch<SetStateAction<MemberOption[]>>;
  searching: boolean;
  selectedMembers: MemberOption[];
  setSelectedMembers: Dispatch<SetStateAction<MemberOption[]>>;
  addMember: (member: MemberOption) => void;
  removeMember: (id: string) => void;
}

/**
 * Owns the debounced "search primary members and build a selection" state shared
 * by the admin family-groups create form and the family-group editor. Both
 * surfaces render the resulting badges/dropdown themselves; only the fetch +
 * selection bookkeeping is shared here.
 */
export function useFamilyGroupMemberPicker(): FamilyGroupMemberPicker {
  const [memberSearch, setMemberSearch] = useState("");
  const [searchResults, setSearchResults] = useState<MemberOption[]>([]);
  const [selectedMembers, setSelectedMembers] = useState<MemberOption[]>([]);
  const [searching, setSearching] = useState(false);

  // Debounced member search
  useEffect(() => {
    if (memberSearch.length < 2) {
      setSearchResults([]);
      return;
    }

    let cancelled = false;
    setSearching(true);

    const timer = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/admin/members?q=${encodeURIComponent(memberSearch)}&type=primary&active=true&pageSize=10`
        );
        if (res.ok && !cancelled) {
          const data = await res.json();
          // Filter out already selected members
          const selectedIds = new Set(selectedMembers.map((member) => member.id));
          setSearchResults(
            (data.members ?? [])
              .filter((member: MemberOption) => !selectedIds.has(member.id))
              .map((member: MemberOption) => ({
                id: member.id,
                firstName: member.firstName,
                lastName: member.lastName,
                email: member.email,
              }))
          );
        }
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 300);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [memberSearch, selectedMembers]);

  function addMember(member: MemberOption) {
    setSelectedMembers((current) => [...current, member]);
    setMemberSearch("");
    setSearchResults([]);
  }

  function removeMember(id: string) {
    setSelectedMembers((current) => current.filter((member) => member.id !== id));
  }

  return {
    memberSearch,
    setMemberSearch,
    searchResults,
    setSearchResults,
    searching,
    selectedMembers,
    setSelectedMembers,
    addMember,
    removeMember,
  };
}
