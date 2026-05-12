export type ParentLinkKind = "PRIMARY" | "SECONDARY";

export type ParentLinkSummary = {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  ageTier?: string;
  active?: boolean;
  canLogin?: boolean;
  inheritEmailFromId?: string | null;
  parentLinkType: ParentLinkKind;
};

export function getParentEmailSourceId(
  parent: { id: string; inheritEmailFromId?: string | null } | null | undefined
) {
  if (!parent) return null;
  return parent.inheritEmailFromId || parent.id;
}

export function buildParentLinks(member: {
  parent?: Omit<ParentLinkSummary, "parentLinkType"> | null;
  secondaryParent?: Omit<ParentLinkSummary, "parentLinkType"> | null;
}) {
  const links: ParentLinkSummary[] = [];
  if (member.parent) {
    links.push({ ...member.parent, parentLinkType: "PRIMARY" });
  }
  if (member.secondaryParent && member.secondaryParent.id !== member.parent?.id) {
    links.push({ ...member.secondaryParent, parentLinkType: "SECONDARY" });
  }
  return links;
}

export function resolveParentNotificationSourceId(
  parentLinks: Array<{ id: string; inheritEmailFromId?: string | null }>,
  selectedId: string | null | undefined
) {
  const normalized = selectedId?.trim() || null;
  if (!normalized) return null;

  const parent = parentLinks.find((link) => link.id === normalized);
  if (parent) {
    return getParentEmailSourceId(parent);
  }

  const source = parentLinks.find(
    (link) => getParentEmailSourceId(link) === normalized
  );
  return source ? normalized : undefined;
}
