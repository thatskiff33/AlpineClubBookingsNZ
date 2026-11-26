/**
 * What the committee and induction actions send an AI app connection
 * (ALP-720, `INV-MCP-006`).
 *
 * A committee holder is named with the email and phone an officer reads on
 * the committee screen, never their access role or the phone's parts. An
 * induction names its member and signers; the inductee's age tier is the
 * only other personal fact, as on the induction register.
 */
import { connectionShapeFor, type ConnectionShape } from "@/lib/connection-projection";
import type { serializeCommitteeAssignment, serializeCommitteeRole } from "@/lib/committee";
import type { MemberInductionWithDetail } from "@/lib/induction";

type CommitteeRoleAnswer = ReturnType<typeof serializeCommitteeRole>;
type CommitteeAssignmentAnswer = ReturnType<typeof serializeCommitteeAssignment>;

const COMMITTEE_ROLE_SHAPE = connectionShapeFor<CommitteeRoleAnswer>({
  id: true,
  key: true,
  name: true,
  description: true,
  contactEmail: true,
  isActive: true,
  sortOrder: true,
  assignmentCount: true,
});

const COMMITTEE_ASSIGNMENT_SHAPE = connectionShapeFor<CommitteeAssignmentAnswer>({
  id: true,
  memberId: true,
  committeeRoleId: true,
  blurb: true,
  sortOrder: true,
  published: true,
  showPhone: true,
  contactable: true,
  contactEmailMode: true,
  contactEmailOverride: true,
  isActive: true,
  updatedAt: true,
  committeeRole: { id: true, name: true, isActive: true },
  member: { id: true, firstName: true, lastName: true, email: true, phone: true, active: true },
  assignedBy: { id: true, displayName: true },
});

export const COMMITTEE_ROLE_LIST_CONNECTION_SHAPE: ConnectionShape = { roles: COMMITTEE_ROLE_SHAPE };

export const COMMITTEE_ROLE_CONNECTION_SHAPE: ConnectionShape = { role: COMMITTEE_ROLE_SHAPE };

export const COMMITTEE_ROLE_DELETED_CONNECTION_SHAPE = connectionShapeFor<{ ok: boolean }>({ ok: true });

export const COMMITTEE_ASSIGNMENT_LIST_CONNECTION_SHAPE: ConnectionShape = {
  assignments: COMMITTEE_ASSIGNMENT_SHAPE,
};

export const COMMITTEE_ASSIGNMENT_CONNECTION_SHAPE: ConnectionShape = {
  assignment: COMMITTEE_ASSIGNMENT_SHAPE,
};

interface InductionPerson {
  id: string;
  firstName: string;
  lastName: string;
}

interface InductionRegisterRow {
  id: string;
  kind: string;
  status: string;
  requiredSignOffs: number;
  signOffCount: number;
  completedAt: Date | null;
  completionSource: string | null;
  createdAt: Date;
  member: InductionPerson & { email: string; ageTier: string };
  assignedSigners: Array<{
    memberId: string;
    firstName: string;
    lastName: string;
    email: string;
    emailSentAt: Date | null;
  }>;
}

export const INDUCTION_LIST_CONNECTION_SHAPE = connectionShapeFor<{ inductions: InductionRegisterRow[] }>({
  inductions: {
    id: true,
    kind: true,
    status: true,
    requiredSignOffs: true,
    signOffCount: true,
    completedAt: true,
    completionSource: true,
    createdAt: true,
    member: { id: true, firstName: true, lastName: true, email: true, ageTier: true },
    assignedSigners: { memberId: true, firstName: true, lastName: true, email: true, emailSentAt: true },
  },
});

/** The checklist as a template or an induction carries it. */
const CHECKLIST_SECTIONS_SHAPE = {
  id: true,
  title: true,
  description: true,
  priority: true,
  sortOrder: true,
  items: {
    id: true,
    label: true,
    competencyPrompt: true,
    notesPrompt: true,
    isMandatory: true,
    requiresDemonstration: true,
    sortOrder: true,
  },
} as const;

export const INDUCTION_DETAIL_CONNECTION_SHAPE = connectionShapeFor<{
  induction: MemberInductionWithDetail;
  declaration: string;
}>({
  induction: {
    id: true,
    memberId: true,
    kind: true,
    status: true,
    requiredSignOffs: true,
    inductionDate: true,
    completedAt: true,
    completionSource: true,
    finalComments: true,
    voidedReason: true,
    createdAt: true,
    member: { id: true, firstName: true, lastName: true },
    template: { id: true, name: true, version: true, kind: true, sections: CHECKLIST_SECTIONS_SHAPE },
    signOffs: {
      id: true,
      signerMemberId: true,
      signerName: true,
      signerRole: true,
      declarationAccepted: true,
      comments: true,
      signedAt: true,
    },
    assignedSigners: {
      memberId: true,
      emailSentAt: true,
      member: { id: true, firstName: true, lastName: true },
    },
  },
  declaration: true,
});

interface CreatedInduction {
  id: string;
  memberId: string;
  templateId: string;
  kind: string;
  status: string;
  requiredSignOffs: number;
  createdAt: Date;
}

export const INDUCTION_CREATED_CONNECTION_SHAPE = connectionShapeFor<{ induction: CreatedInduction }>({
  induction: {
    id: true,
    memberId: true,
    templateId: true,
    kind: true,
    status: true,
    requiredSignOffs: true,
    createdAt: true,
  },
});

export const INDUCTION_UPDATED_CONNECTION_SHAPE = connectionShapeFor<{ ok: boolean }>({ ok: true });

interface InductionTemplateSummary {
  id: string;
  name: string;
  version: string;
  kind: string;
  sourceLabel: string | null;
  isActive: boolean;
  createdAt: Date;
  sectionCount: number;
  inductionCount: number;
  used: boolean;
}

export const INDUCTION_TEMPLATE_LIST_CONNECTION_SHAPE = connectionShapeFor<{
  templates: InductionTemplateSummary[];
}>({
  templates: {
    id: true,
    name: true,
    version: true,
    kind: true,
    sourceLabel: true,
    isActive: true,
    sectionCount: true,
    inductionCount: true,
  },
});

const INDUCTION_TEMPLATE_SHAPE = {
  id: true,
  name: true,
  version: true,
  kind: true,
  sourceLabel: true,
  isActive: true,
  sections: CHECKLIST_SECTIONS_SHAPE,
} as const;

export const INDUCTION_TEMPLATE_DETAIL_CONNECTION_SHAPE = connectionShapeFor<{
  template: MemberInductionWithDetail["template"];
  used: boolean;
}>({
  template: INDUCTION_TEMPLATE_SHAPE,
  used: true,
});

/** A template an officer created or rewrote: the same fields as the detail read. */
export const INDUCTION_TEMPLATE_CONNECTION_SHAPE = connectionShapeFor<{
  template: MemberInductionWithDetail["template"];
}>({
  template: INDUCTION_TEMPLATE_SHAPE,
});
