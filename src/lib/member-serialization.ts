export type MemberSummary = {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
};

export type MemberSummaryInput = {
  firstName?: string | null;
  lastName?: string | null;
};

export function cleanText(value: string | null | undefined): string | null {
  const cleaned = value?.trim() ?? "";
  return cleaned ? cleaned : null;
}

export function memberName(member: MemberSummaryInput): string {
  return [member.firstName, member.lastName]
    .filter(Boolean)
    .join(" ")
    .trim();
}

export function memberDisplayName(
  member: MemberSummaryInput & { email?: string | null },
): string {
  return memberName(member) || member.email || "Unknown member";
}

export function serializeDate(
  value: Date | string | null | undefined,
): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return new Date(value).toISOString();
}

export function serializeMember(
  member: MemberSummary | null,
): { id: string; name: string; email: string } | null {
  if (!member) return null;
  return {
    id: member.id,
    name: memberName(member),
    email: member.email,
  };
}
