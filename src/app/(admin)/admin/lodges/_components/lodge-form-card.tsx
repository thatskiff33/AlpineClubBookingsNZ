"use client";

import type { Dispatch, SetStateAction } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ViewOnlyActionButton } from "@/components/admin/view-only-action";
import {
  LodgeBankAndGstFields,
  LodgePostalAddressField,
} from "@/components/admin/lodge-invoice-details-fields";
import { AddLodgeCapacityField } from "./add-lodge-capacity-field";
import type { LodgeDetailField, LodgeFormState } from "./lodge-form";

/**
 * The Admin -> Lodges add/edit form card. The page owns the state, the save and
 * the failure focus; this renders the fields. The invoice details (fork #115)
 * show on the edit form only (fork #123).
 *
 * The page renders the lodge-area view-only banner above this card and says so
 * with `ancestorRendersViewOnlyBanner`; rendered anywhere else, Save keeps its
 * own view-only reason (#2168).
 */
export function LodgeFormCard({
  creating,
  form,
  setForm,
  canEdit,
  saving,
  capacityInvalid,
  errorId,
  onSubmit,
  onCancel,
  ancestorRendersViewOnlyBanner = false,
}: {
  creating: boolean;
  form: LodgeFormState;
  setForm: Dispatch<SetStateAction<LodgeFormState>>;
  canEdit: boolean;
  saving: boolean;
  /** The capacity field is marked invalid while its failure is shown. */
  capacityInvalid: boolean;
  /** The page's action-error alert, which the capacity field describes itself by. */
  errorId: string;
  onSubmit: () => void;
  onCancel: () => void;
  ancestorRendersViewOnlyBanner?: boolean;
}) {
  const invoiceFieldProps = {
    idPrefix: "lodge",
    values: form,
    disabled: !canEdit,
    onChange: (field: LodgeDetailField, value: string) =>
      setForm((prev) => ({ ...prev, [field]: value })),
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{creating ? "Add lodge" : "Edit lodge"}</CardTitle>
        <CardDescription>
          The address feeds the public {"{{lodge-address}}"} content token.
          The door code and travel note appear in booking and pre-arrival
          emails for this lodge.
          {creating
            ? null
            : " The postal address, bank details and GST number are printed only on the invoice a booker can download from their booking."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="lodge-name">Name</Label>
          <Input
            id="lodge-name"
            value={form.name}
            maxLength={120}
            onChange={(event) =>
              setForm((prev) => ({ ...prev, name: event.target.value }))
            }
          />
        </div>
        {creating ? (
          <AddLodgeCapacityField
            value={form.capacity}
            onChange={(capacity) => setForm((prev) => ({ ...prev, capacity }))}
            invalid={capacityInvalid}
            errorId={errorId}
          />
        ) : null}
        <div className="grid gap-4 sm:grid-cols-2">
          <div className={creating ? "space-y-2 sm:col-span-2" : "space-y-2"}>
            <Label htmlFor="lodge-address">Address</Label>
            <Textarea
              id="lodge-address"
              value={form.address}
              maxLength={300}
              rows={2}
              placeholder="Optional — feeds the public {{lodge-address}} token"
              onChange={(event) =>
                setForm((prev) => ({ ...prev, address: event.target.value }))
              }
            />
          </div>
          {creating ? null : <LodgePostalAddressField {...invoiceFieldProps} />}
        </div>
        <div className="space-y-2">
          <Label htmlFor="lodge-door-code">Door code</Label>
          <Input
            id="lodge-door-code"
            value={form.doorCode}
            maxLength={80}
            onChange={(event) =>
              setForm((prev) => ({ ...prev, doorCode: event.target.value }))
            }
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="lodge-travel-note">Travel note</Label>
          <Textarea
            id="lodge-travel-note"
            value={form.travelNote}
            maxLength={2000}
            rows={3}
            onChange={(event) =>
              setForm((prev) => ({
                ...prev,
                travelNote: event.target.value,
              }))
            }
          />
        </div>
        {creating ? null : <LodgeBankAndGstFields {...invoiceFieldProps} />}
        <div className="flex gap-2">
          <ViewOnlyActionButton canEdit={canEdit} describeReason={!ancestorRendersViewOnlyBanner} onClick={onSubmit} disabled={saving}>
            {saving ? "Saving..." : "Save"}
          </ViewOnlyActionButton>
          <Button variant="outline" onClick={onCancel} disabled={saving}>
            <X className="mr-2 h-4 w-4" />
            Cancel
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
