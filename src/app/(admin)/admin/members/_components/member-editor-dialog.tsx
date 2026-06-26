"use client";

import { useEffect, useState } from "react";
import type { FinanceAccessLevel } from "@prisma/client";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useMemberFieldsSettings } from "@/lib/use-member-fields-settings";
import { GENDER_OPTIONS, TITLE_OPTIONS } from "@/lib/member-enums";
import { MEMBER_SETUP_INVITE_TTL_DAYS } from "@/lib/member-setup-invite";
import { useXeroEntranceFeeDecision } from "@/lib/admin-xero-entrance-fee";
import {
  linkMemberXeroContact,
  pushMemberToXero,
  searchXeroContacts,
  unlinkMemberXeroContact,
} from "@/lib/admin-member-xero-actions";
import { memberName } from "@/lib/member-serialization";
import type {
  Member,
  MemberForm,
  PendingXeroCreateDecision,
  XeroChoice,
} from "../_types";
import { emptyForm, getMissingFieldsForXeroCreate } from "../_utils";
import { MemberXeroControls } from "./member-xero-controls";
import { MemberXeroDuplicateDecisionDialog } from "./member-xero-duplicate-decision-dialog";

interface MemberEditorDialogProps {
  open: boolean;
  editingMember?: Member | null;
  xeroConnected: boolean | null;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
  onSuccess: (message: string) => void;
  onWarning: (message: string) => void;
}

interface MemberSaveResponse {
  id: string;
  firstName?: string | null;
  lastName?: string | null;
  warning?: string;
}

function memberToForm(member: Member | null): MemberForm {
  if (!member) return emptyForm;

  return {
    title: member.title || "",
    firstName: member.firstName,
    lastName: member.lastName,
    gender: member.gender || "",
    email: member.email,
    phoneCountryCode: member.phoneCountryCode || "",
    phoneAreaCode: member.phoneAreaCode || "",
    phoneNumber: member.phoneNumber || "",
    dateOfBirth: member.dateOfBirth || "",
    role: member.role,
    ageTier: member.ageTier,
    financeAccessLevel: member.financeAccessLevel,
    active: member.active,
    sendInvite: false,
    forcePasswordChange: member.forcePasswordChange,
    joinedDate: member.joinedDate || "",
    lifeMemberDate: member.lifeMemberDate || "",
    occupation: member.occupation || "",
    comments: member.comments || "",
    canLogin: member.canLogin,
    streetAddressLine1: member.streetAddressLine1 || "",
    streetAddressLine2: member.streetAddressLine2 || "",
    streetCity: member.streetCity || "",
    streetRegion: member.streetRegion || "",
    streetPostalCode: member.streetPostalCode || "",
    streetCountry: member.streetCountry || "",
    postalAddressLine1: member.postalAddressLine1 || "",
    postalAddressLine2: member.postalAddressLine2 || "",
    postalCity: member.postalCity || "",
    postalRegion: member.postalRegion || "",
    postalPostalCode: member.postalPostalCode || "",
    postalCountry: member.postalCountry || "",
  };
}

export function MemberEditorDialog({
  open,
  editingMember = null,
  xeroConnected,
  onOpenChange,
  onSaved,
  onSuccess,
  onWarning,
}: MemberEditorDialogProps) {
  const [currentEditingMember, setCurrentEditingMember] =
    useState<Member | null>(editingMember);
  const [form, setForm] = useState<MemberForm>(memberToForm(editingMember));
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const [xeroChoice, setXeroChoice] = useState<XeroChoice>("");
  const [xeroUnlinking, setXeroUnlinking] = useState(false);
  const [xeroSearchQuery, setXeroSearchQuery] = useState("");
  const [xeroSearchResults, setXeroSearchResults] = useState<
    Awaited<ReturnType<typeof searchXeroContacts>>
  >([]);
  const [xeroSearchLoading, setXeroSearchLoading] = useState(false);
  const [selectedXeroContactId, setSelectedXeroContactId] = useState("");
  const entranceFeeDecision = useXeroEntranceFeeDecision();
  const { showTitle, showGender, showOccupation } = useMemberFieldsSettings();
  const [pendingXeroCreateDecision, setPendingXeroCreateDecision] =
    useState<PendingXeroCreateDecision | null>(null);
  const [pendingXeroDecisionContactId, setPendingXeroDecisionContactId] =
    useState("");
  const [pendingXeroDecisionError, setPendingXeroDecisionError] = useState("");
  const [pendingXeroDecisionLoading, setPendingXeroDecisionLoading] =
    useState(false);
  const { resetXeroEntranceFeeDecision } = entranceFeeDecision;

  useEffect(() => {
    if (!open) return;
    setCurrentEditingMember(editingMember);
    setForm(memberToForm(editingMember));
    setXeroChoice("");
    setXeroSearchQuery("");
    setXeroSearchResults([]);
    setSelectedXeroContactId("");
    resetXeroEntranceFeeDecision();
    setFormError("");
  }, [editingMember, open, resetXeroEntranceFeeDecision]);

  const handleXeroChoiceChange = (value: XeroChoice) => {
    setXeroChoice(value);
    setFormError("");
    setSelectedXeroContactId("");
    if (value !== "link") {
      setXeroSearchQuery("");
      setXeroSearchResults([]);
    }
    if (value !== "create") {
      entranceFeeDecision.resetXeroEntranceFeeDecision();
    }
  };

  const handleXeroUnlink = async (memberId: string) => {
    setXeroUnlinking(true);
    setFormError("");
    try {
      await unlinkMemberXeroContact(memberId);
      setCurrentEditingMember((member) =>
        member
          ? { ...member, xeroContactId: null, xeroContactGroups: [] }
          : member,
      );
      setXeroChoice("");
      onSuccess("Xero contact unlinked");
      onSaved();
    } catch (err) {
      setFormError(
        err instanceof Error ? err.message : "Failed to unlink Xero contact",
      );
    } finally {
      setXeroUnlinking(false);
    }
  };

  const handleXeroLink = async (memberId: string, contactId: string) => {
    setFormError("");
    try {
      const data = await linkMemberXeroContact(memberId, contactId);
      setCurrentEditingMember((member) =>
        member
          ? { ...member, xeroContactId: contactId, xeroContactGroups: [] }
          : member,
      );
      setXeroChoice("");
      setSelectedXeroContactId("");
      setXeroSearchResults([]);
      onSuccess(`Linked to Xero contact: ${data.contactName}`);
      onSaved();
    } catch (err) {
      setFormError(
        err instanceof Error ? err.message : "Failed to link Xero contact",
      );
    }
  };

  const handleXeroPush = async (memberId: string, displayName: string) => {
    setFormError("");
    try {
      const entranceFeeInvoiceOptions =
        entranceFeeDecision.buildXeroEntranceFeeInvoiceOptions();
      const result = await pushMemberToXero(
        memberId,
        entranceFeeInvoiceOptions,
      );

      if (result.status === "needsDecision") {
        setPendingXeroCreateDecision({
          memberId,
          memberName: displayName,
          entranceFeeInvoiceOptions,
          suggestedContacts: result.suggestedContacts,
        });
        setPendingXeroDecisionContactId(
          result.suggestedContacts.find((contact) => !contact.isLinked)
            ?.contactId ?? "",
        );
        setPendingXeroDecisionError("");
        return;
      }

      setCurrentEditingMember((member) =>
        member
          ? {
              ...member,
              xeroContactId: result.data.xeroContactId,
              xeroContactGroups: [],
            }
          : member,
      );
      setXeroChoice("");
      onSuccess(
        entranceFeeInvoiceOptions.createEntranceFeeInvoice &&
          result.data.entranceFeeInvoiceQueued
          ? "Xero contact created, linked, and entrance fee invoice queued"
          : "Xero contact created and linked",
      );
      const warningMessage =
        result.data.warning ||
        (entranceFeeInvoiceOptions.createEntranceFeeInvoice &&
        result.data.entranceFeeInvoiceMessage &&
        !result.data.entranceFeeInvoiceQueued
          ? result.data.entranceFeeInvoiceMessage
          : "");
      if (warningMessage) onWarning(warningMessage);
      onSaved();
    } catch (err) {
      setFormError(
        err instanceof Error ? err.message : "Failed to create Xero contact",
      );
    }
  };

  const closePendingXeroCreateDecision = () => {
    setPendingXeroCreateDecision(null);
    setPendingXeroDecisionContactId("");
    setPendingXeroDecisionError("");
    setPendingXeroDecisionLoading(false);
  };

  const handlePendingXeroDecisionLink = async () => {
    if (!pendingXeroCreateDecision || !pendingXeroDecisionContactId) return;

    setPendingXeroDecisionLoading(true);
    setPendingXeroDecisionError("");
    try {
      const decision = pendingXeroCreateDecision;
      const data = await linkMemberXeroContact(
        decision.memberId,
        pendingXeroDecisionContactId,
      );

      if (currentEditingMember?.id === decision.memberId) {
        setCurrentEditingMember({
          ...currentEditingMember,
          xeroContactId: pendingXeroDecisionContactId,
          xeroContactGroups: [],
        });
      }

      closePendingXeroCreateDecision();
      setXeroChoice("");
      onSuccess(`Linked to Xero contact: ${data.contactName}`);
      onSaved();
    } catch (err) {
      setPendingXeroDecisionError(
        err instanceof Error ? err.message : "Failed to link Xero contact",
      );
    } finally {
      setPendingXeroDecisionLoading(false);
    }
  };

  const handlePendingXeroDecisionForceCreate = async () => {
    if (!pendingXeroCreateDecision) return;

    setPendingXeroDecisionLoading(true);
    setPendingXeroDecisionError("");
    try {
      const decision = pendingXeroCreateDecision;
      const result = await pushMemberToXero(decision.memberId, {
        forceCreate: true,
        ...decision.entranceFeeInvoiceOptions,
      });

      if (result.status !== "created")
        throw new Error("Failed to create Xero contact");

      if (currentEditingMember?.id === decision.memberId) {
        setCurrentEditingMember({
          ...currentEditingMember,
          xeroContactId: result.data.xeroContactId,
          xeroContactGroups: [],
        });
      }

      const warning =
        result.data.warning ||
        (decision.entranceFeeInvoiceOptions.createEntranceFeeInvoice &&
        result.data.entranceFeeInvoiceMessage &&
        !result.data.entranceFeeInvoiceQueued
          ? result.data.entranceFeeInvoiceMessage
          : undefined);

      closePendingXeroCreateDecision();
      setXeroChoice("");
      onSuccess(
        decision.entranceFeeInvoiceOptions.createEntranceFeeInvoice &&
          result.data.entranceFeeInvoiceQueued
          ? "Xero contact created, linked, and entrance fee invoice queued"
          : "Xero contact created and linked",
      );
      if (warning) onWarning(warning);
      onSaved();
    } catch (err) {
      setPendingXeroDecisionError(
        err instanceof Error ? err.message : "Failed to create Xero contact",
      );
    } finally {
      setPendingXeroDecisionLoading(false);
    }
  };

  const handleXeroSearch = async () => {
    const query =
      xeroSearchQuery.trim() ||
      form.email.trim() ||
      [form.firstName.trim(), form.lastName.trim()].filter(Boolean).join(" ");
    if (query.length < 2) {
      setFormError(
        "Enter at least 2 characters in the Xero search field, or complete the member name/email first.",
      );
      return;
    }

    setXeroSearchLoading(true);
    setFormError("");
    try {
      const contacts = await searchXeroContacts(query);
      const availableContacts = contacts.filter((contact) => !contact.isLinked);
      setXeroSearchResults(availableContacts);
      if (availableContacts.length === 0) setSelectedXeroContactId("");
    } catch (err) {
      setXeroSearchResults([]);
      setSelectedXeroContactId("");
      setFormError(
        err instanceof Error ? err.message : "Failed to search Xero contacts",
      );
    } finally {
      setXeroSearchLoading(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setFormError("");
    try {
      if (!currentEditingMember && xeroConnected === null) {
        throw new Error(
          "Still checking Xero connection status. Please try again in a moment.",
        );
      }
      if (!currentEditingMember && xeroConnected) {
        if (!xeroChoice) {
          throw new Error(
            "Choose whether to link an existing Xero contact or create a new one.",
          );
        }
        if (xeroChoice === "link" && !selectedXeroContactId) {
          throw new Error(
            "Select an existing unlinked Xero contact before creating the member.",
          );
        }
        if (xeroChoice === "create") {
          const missingFields = getMissingFieldsForXeroCreate(form);
          if (missingFields.length > 0) {
            throw new Error(
              `Complete these fields before creating in Xero: ${missingFields.join(", ")}`,
            );
          }
        }
      }

      const entranceFeeInvoiceOptions =
        !currentEditingMember && xeroConnected && xeroChoice === "create"
          ? entranceFeeDecision.buildXeroEntranceFeeInvoiceOptions()
          : null;
      const url = currentEditingMember
        ? `/api/admin/members/${currentEditingMember.id}`
        : "/api/admin/members";
      const body: Record<string, unknown> = {
        title: form.title || null,
        firstName: form.firstName,
        lastName: form.lastName,
        gender: form.gender || null,
        email: form.email,
        phoneCountryCode: form.phoneCountryCode || null,
        phoneAreaCode: form.phoneAreaCode || null,
        phoneNumber: form.phoneNumber || null,
        dateOfBirth: form.dateOfBirth || null,
        role: form.role,
        ageTier: form.ageTier,
        financeAccessLevel: form.financeAccessLevel,
        active: form.active,
        canLogin: form.canLogin,
        joinedDate: form.joinedDate || null,
        lifeMemberDate: form.lifeMemberDate || null,
        occupation: form.occupation || null,
        comments: form.comments || null,
        streetAddressLine1: form.streetAddressLine1 || null,
        streetAddressLine2: form.streetAddressLine2 || null,
        streetCity: form.streetCity || null,
        streetRegion: form.streetRegion || null,
        streetPostalCode: form.streetPostalCode || null,
        streetCountry: form.streetCountry || null,
        postalAddressLine1: form.postalAddressLine1 || null,
        postalAddressLine2: form.postalAddressLine2 || null,
        postalCity: form.postalCity || null,
        postalRegion: form.postalRegion || null,
        postalPostalCode: form.postalPostalCode || null,
        postalCountry: form.postalCountry || null,
      };
      if (currentEditingMember)
        body.forcePasswordChange = form.forcePasswordChange;
      if (!currentEditingMember) body.sendInvite = form.sendInvite;

      const res = await fetch(url, {
        method: currentEditingMember ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res
        .json()
        .catch(() => ({}))) as MemberSaveResponse & { error?: string };
      if (!res.ok) throw new Error(data.error || "Save failed");

      let warning = data.warning;
      let successMessage = currentEditingMember
        ? "Member updated"
        : "Member created";

      if (!currentEditingMember && xeroConnected) {
        if (xeroChoice === "link") {
          try {
            await linkMemberXeroContact(data.id, selectedXeroContactId);
            successMessage = "Member created and linked to Xero";
          } catch (err) {
            warning = `Member created, but Xero link failed: ${
              err instanceof Error ? err.message : "Unknown error"
            }`;
          }
        } else if (xeroChoice === "create") {
          try {
            const pushResult = await pushMemberToXero(data.id, {
              ...(entranceFeeInvoiceOptions ?? {
                createEntranceFeeInvoice: false,
              }),
            });

            if (pushResult.status === "needsDecision") {
              setPendingXeroCreateDecision({
                memberId: data.id,
                memberName: memberName({
                  firstName: data.firstName || form.firstName,
                  lastName: data.lastName || form.lastName,
                }),
                entranceFeeInvoiceOptions: entranceFeeInvoiceOptions ?? {
                  createEntranceFeeInvoice: false,
                  entranceFeeInvoiceDecision: "SKIP",
                  entranceFeeInvoiceSkipReason:
                    "No entrance fee invoice requested",
                },
                suggestedContacts: pushResult.suggestedContacts,
              });
              setPendingXeroDecisionContactId(
                pushResult.suggestedContacts.find(
                  (contact) => !contact.isLinked,
                )?.contactId ?? "",
              );
              setPendingXeroDecisionError("");
              successMessage =
                "Member created locally. Review the suggested Xero matches before creating a new contact.";
            } else {
              successMessage =
                entranceFeeInvoiceOptions?.createEntranceFeeInvoice &&
                pushResult.data.entranceFeeInvoiceQueued
                  ? "Member created, pushed to Xero, and entrance fee invoice queued"
                  : "Member created and pushed to Xero";
              warning =
                pushResult.data.warning ||
                (entranceFeeInvoiceOptions?.createEntranceFeeInvoice &&
                pushResult.data.entranceFeeInvoiceMessage &&
                !pushResult.data.entranceFeeInvoiceQueued
                  ? pushResult.data.entranceFeeInvoiceMessage
                  : warning);
            }
          } catch (err) {
            warning = `Member created, but Xero contact creation failed: ${
              err instanceof Error ? err.message : "Unknown error"
            }`;
          }
        }
      }

      onOpenChange(false);
      onSuccess(successMessage);
      if (warning) onWarning(warning);
      onSaved();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const setCanLogin = (canLogin: boolean) => {
    setForm((current) => ({
      ...current,
      canLogin,
      sendInvite: canLogin ? current.sendInvite : false,
      financeAccessLevel: canLogin ? current.financeAccessLevel : "NONE",
    }));
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          className="sm:max-w-2xl max-h-[90vh] overflow-y-auto"
          onInteractOutside={(event) => event.preventDefault()}
          onEscapeKeyDown={(event) => event.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle>
              {currentEditingMember ? "Edit Member" : "Add Member"}
            </DialogTitle>
            <DialogDescription>
              {currentEditingMember
                ? "Update the member details."
                : "Create a new member account."}
            </DialogDescription>
          </DialogHeader>
          {formError && (
            <div className="p-2 bg-red-50 border border-red-200 text-red-700 rounded text-sm">
              {formError}
            </div>
          )}
          <div className="grid gap-4 py-2">
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="canLogin"
                checked={form.canLogin}
                onChange={(event) => setCanLogin(event.target.checked)}
                className="h-4 w-4 rounded border-gray-300"
              />
              <Label htmlFor="canLogin">Can Login</Label>
              <p className="text-xs text-muted-foreground ml-2">
                Adults who can sign in and make bookings. Uncheck for
                children/youth managed by family group.
              </p>
            </div>

            {(showTitle || showGender) && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {showTitle && (
                  <div className="space-y-2">
                    <Label htmlFor="title">Title</Label>
                    <Select
                      value={form.title || "__none__"}
                      onValueChange={(value) =>
                        setForm((current) => ({
                          ...current,
                          title:
                            value === "__none__"
                              ? ""
                              : (value as MemberForm["title"]),
                        }))
                      }
                    >
                      <SelectTrigger id="title">
                        <SelectValue placeholder="Select title" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none__">None</SelectItem>
                        {TITLE_OPTIONS.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
                {showGender && (
                  <div className="space-y-2">
                    <Label htmlFor="gender">Gender</Label>
                    <Select
                      value={form.gender || "__none__"}
                      onValueChange={(value) =>
                        setForm((current) => ({
                          ...current,
                          gender:
                            value === "__none__"
                              ? ""
                              : (value as MemberForm["gender"]),
                        }))
                      }
                    >
                      <SelectTrigger id="gender">
                        <SelectValue placeholder="Select gender" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none__">None</SelectItem>
                        {GENDER_OPTIONS.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="firstName">First Name *</Label>
                <Input
                  id="firstName"
                  value={form.firstName}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      firstName: event.target.value,
                    }))
                  }
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="lastName">Last Name *</Label>
                <Input
                  id="lastName"
                  value={form.lastName}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      lastName: event.target.value,
                    }))
                  }
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="email">Email *</Label>
              <Input
                id="email"
                type="email"
                value={form.email}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    email: event.target.value,
                  }))
                }
              />
            </div>

            <div className="space-y-2">
              <Label>Phone</Label>
              <div className="flex gap-2">
                <Input
                  className="w-20"
                  placeholder="64"
                  value={form.phoneCountryCode}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      phoneCountryCode: event.target.value,
                    }))
                  }
                  maxLength={5}
                  aria-label="Country code"
                />
                <Input
                  className="w-20"
                  placeholder="27"
                  value={form.phoneAreaCode}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      phoneAreaCode: event.target.value,
                    }))
                  }
                  maxLength={5}
                  aria-label="Area code"
                />
                <Input
                  className="flex-1"
                  placeholder="123 4567"
                  value={form.phoneNumber}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      phoneNumber: event.target.value,
                    }))
                  }
                  maxLength={15}
                  aria-label="Phone number"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="dateOfBirth">Date of Birth</Label>
                <Input
                  id="dateOfBirth"
                  type="date"
                  value={form.dateOfBirth}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      dateOfBirth: event.target.value,
                    }))
                  }
                />
                <p className="text-xs text-muted-foreground">
                  Age tier is calculated automatically from date of birth.
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="joinedDate">
                  {!currentEditingMember && xeroChoice === "create"
                    ? "Joined Date *"
                    : "Joined Date"}
                </Label>
                <Input
                  id="joinedDate"
                  type="date"
                  value={form.joinedDate}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      joinedDate: event.target.value,
                    }))
                  }
                />
                <p className="text-xs text-muted-foreground">
                  Required when creating a new Xero contact.
                </p>
              </div>
            </div>

            {showOccupation && form.ageTier === "ADULT" && (
              <div className="space-y-2">
                <Label htmlFor="occupation">Occupation</Label>
                <Input
                  id="occupation"
                  value={form.occupation}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      occupation: event.target.value,
                    }))
                  }
                />
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label>Role</Label>
                <Select
                  value={form.role}
                  onValueChange={(value) =>
                    setForm((current) => ({
                      ...current,
                      role: value as
                        | "MEMBER"
                        | "ADMIN"
                        | "LODGE"
                        | "ASSOCIATE"
                        | "LIFE",
                    }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="MEMBER">Member</SelectItem>
                    <SelectItem value="ADMIN">Admin</SelectItem>
                    <SelectItem value="LODGE">Lodge</SelectItem>
                    <SelectItem value="ASSOCIATE">Associate Member</SelectItem>
                    <SelectItem value="LIFE">Life Member</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Finance Access</Label>
                <Select
                  value={form.financeAccessLevel}
                  onValueChange={(value) =>
                    setForm((current) => ({
                      ...current,
                      financeAccessLevel: value as FinanceAccessLevel,
                    }))
                  }
                  disabled={!form.canLogin}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="NONE">No Finance Access</SelectItem>
                    <SelectItem value="VIEWER">Finance Viewer</SelectItem>
                    <SelectItem value="MANAGER">Finance Manager</SelectItem>
                  </SelectContent>
                </Select>
                {!form.canLogin && (
                  <p className="text-xs text-muted-foreground">
                    Finance access only applies to login-enabled members.
                  </p>
                )}
              </div>
              <div className="space-y-2">
                <Label>Age Tier</Label>
                <Select
                  value={form.ageTier}
                  onValueChange={(value) =>
                    setForm((current) => ({
                      ...current,
                      ageTier: value as MemberForm["ageTier"],
                    }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="INFANT">Infant</SelectItem>
                    <SelectItem value="CHILD">Child</SelectItem>
                    <SelectItem value="YOUTH">Youth</SelectItem>
                    <SelectItem value="ADULT">Adult</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <AddressFields
              title="Physical Address"
              values={{
                line1: form.streetAddressLine1,
                line2: form.streetAddressLine2,
                city: form.streetCity,
                region: form.streetRegion,
                postalCode: form.streetPostalCode,
                country: form.streetCountry,
              }}
              onChange={(field, value) =>
                setForm((current) => ({
                  ...current,
                  [`street${field}`]: value,
                }))
              }
            />
            <AddressFields
              title="Postal Address"
              values={{
                line1: form.postalAddressLine1,
                line2: form.postalAddressLine2,
                city: form.postalCity,
                region: form.postalRegion,
                postalCode: form.postalPostalCode,
                country: form.postalCountry,
              }}
              onChange={(field, value) =>
                setForm((current) => ({
                  ...current,
                  [`postal${field}`]: value,
                }))
              }
            />

            {form.role === "LIFE" && (
              <div className="space-y-2">
                <Label htmlFor="lifeMemberDate">Life member from</Label>
                <Input
                  id="lifeMemberDate"
                  type="date"
                  value={form.lifeMemberDate}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      lifeMemberDate: event.target.value,
                    }))
                  }
                />
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="comments">Comments</Label>
              <Textarea
                id="comments"
                rows={4}
                value={form.comments}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    comments: event.target.value,
                  }))
                }
              />
            </div>

            <MemberXeroControls
              editingMember={currentEditingMember}
              form={form}
              xeroConnected={xeroConnected}
              xeroChoice={xeroChoice}
              xeroUnlinking={xeroUnlinking}
              xeroSearchQuery={xeroSearchQuery}
              xeroSearchResults={xeroSearchResults}
              xeroSearchLoading={xeroSearchLoading}
              selectedXeroContactId={selectedXeroContactId}
              entranceFeeDecision={entranceFeeDecision}
              onChangeXeroChoice={handleXeroChoiceChange}
              onChangeXeroSearchQuery={setXeroSearchQuery}
              onChangeSelectedXeroContactId={setSelectedXeroContactId}
              onXeroSearch={handleXeroSearch}
              onXeroLink={handleXeroLink}
              onXeroUnlink={handleXeroUnlink}
              onXeroPush={handleXeroPush}
              onClearFormError={() => setFormError("")}
            />

            {currentEditingMember && (
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="active"
                  checked={form.active}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      active: event.target.checked,
                    }))
                  }
                  className="h-4 w-4 rounded border-gray-300"
                />
                <Label htmlFor="active">Active</Label>
              </div>
            )}

            {currentEditingMember && (
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="forcePasswordChange"
                  checked={form.forcePasswordChange}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      forcePasswordChange: event.target.checked,
                    }))
                  }
                  className="h-4 w-4 rounded border-gray-300"
                />
                <Label htmlFor="forcePasswordChange">
                  Force Password Change on Next Login
                </Label>
              </div>
            )}

            {!currentEditingMember && form.canLogin && (
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="sendInvite"
                  checked={form.sendInvite}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      sendInvite: event.target.checked,
                    }))
                  }
                  className="h-4 w-4 rounded border-gray-300"
                />
                <Label htmlFor="sendInvite">
                  Send account setup invite ({MEMBER_SETUP_INVITE_TTL_DAYS}-day
                  link)
                </Label>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button
              onClick={handleSave}
              disabled={
                saving || (!currentEditingMember && xeroConnected === null)
              }
            >
              {saving
                ? "Saving..."
                : currentEditingMember
                  ? "Save Changes"
                  : "Create Member"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <MemberXeroDuplicateDecisionDialog
        decision={pendingXeroCreateDecision}
        selectedContactId={pendingXeroDecisionContactId}
        error={pendingXeroDecisionError}
        loading={pendingXeroDecisionLoading}
        onSelectedContactChange={setPendingXeroDecisionContactId}
        onClose={closePendingXeroCreateDecision}
        onLinkSelected={handlePendingXeroDecisionLink}
        onForceCreate={handlePendingXeroDecisionForceCreate}
      />
    </>
  );
}

function AddressFields({
  title,
  values,
  onChange,
}: {
  title: string;
  values: {
    line1: string;
    line2: string;
    city: string;
    region: string;
    postalCode: string;
    country: string;
  };
  onChange: (
    field:
      | "AddressLine1"
      | "AddressLine2"
      | "City"
      | "Region"
      | "PostalCode"
      | "Country",
    value: string,
  ) => void;
}) {
  return (
    <fieldset className="space-y-3 pt-2 border-t">
      <legend className="text-sm font-medium">{title}</legend>
      <Input
        placeholder="Address line 1"
        value={values.line1}
        onChange={(event) => onChange("AddressLine1", event.target.value)}
        maxLength={200}
      />
      <Input
        placeholder="Address line 2"
        value={values.line2}
        onChange={(event) => onChange("AddressLine2", event.target.value)}
        maxLength={200}
      />
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <Input
          placeholder="City"
          value={values.city}
          onChange={(event) => onChange("City", event.target.value)}
          maxLength={200}
        />
        <Input
          placeholder="Region"
          value={values.region}
          onChange={(event) => onChange("Region", event.target.value)}
          maxLength={200}
        />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <Input
          placeholder="Postal code"
          value={values.postalCode}
          onChange={(event) => onChange("PostalCode", event.target.value)}
          maxLength={20}
        />
        <Input
          placeholder="Country"
          value={values.country}
          onChange={(event) => onChange("Country", event.target.value)}
          maxLength={100}
        />
      </div>
    </fieldset>
  );
}
