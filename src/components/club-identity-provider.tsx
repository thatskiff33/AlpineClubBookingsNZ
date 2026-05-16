"use client";

import { createContext, useContext } from "react";
import type { ClubIdentity } from "@/config/club-identity-types";

const ClubIdentityContext = createContext<ClubIdentity | null>(null);

export function ClubIdentityProvider({
  children,
  value,
}: {
  children: React.ReactNode;
  value: ClubIdentity;
}) {
  return (
    <ClubIdentityContext.Provider value={value}>
      {children}
    </ClubIdentityContext.Provider>
  );
}

export function useClubIdentity(): ClubIdentity {
  const value = useContext(ClubIdentityContext);
  if (!value) {
    throw new Error("useClubIdentity must be used within ClubIdentityProvider");
  }
  return value;
}
