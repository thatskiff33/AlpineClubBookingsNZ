"use client";

import type { ReactNode } from "react";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { AddressAutocomplete } from "@/components/address-autocomplete";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  copyStreetAddressToPostal,
  pickStreetAddressValues,
  STREET_TO_POSTAL_FIELD_MAP,
  type MemberAddressValues,
  type StreetAddressField,
} from "@/lib/member-address";
import { cn } from "@/lib/utils";

interface MemberAddressFieldsProps {
  values: MemberAddressValues;
  sameAsPhysical: boolean;
  onSameAsPhysicalChange: (checked: boolean) => void;
  onValuesChange: (patch: Partial<MemberAddressValues>) => void;
  collapsible?: boolean;
  className?: string;
  disabled?: boolean;
  idPrefix?: string;
  physicalDescription?: ReactNode;
  postalDescription?: ReactNode;
  readOnly?: boolean;
  required?: boolean;
}

export function MemberAddressFields({
  className,
  collapsible = false,
  disabled = false,
  idPrefix = "address",
  onSameAsPhysicalChange,
  onValuesChange,
  physicalDescription,
  postalDescription,
  readOnly = false,
  required = false,
  sameAsPhysical,
  values,
}: MemberAddressFieldsProps) {
  const streetValues = pickStreetAddressValues(values);
  const readOnlyInputClassName = readOnly
    ? "bg-slate-50 text-slate-900 shadow-none focus-visible:ring-0"
    : undefined;

  function applyStreetPatch(patch: Partial<MemberAddressValues>) {
    if (readOnly) return;

    if (!sameAsPhysical) {
      onValuesChange(patch);
      return;
    }

    const nextStreetValues = {
      ...streetValues,
      ...patch,
    };

    onValuesChange({
      ...patch,
      ...copyStreetAddressToPostal(nextStreetValues),
    });
  }

  function handleStreetFieldChange(field: StreetAddressField, value: string) {
    if (readOnly) return;

    const patch = {
      [field]: value,
    } as Partial<MemberAddressValues>;

    if (!sameAsPhysical) {
      onValuesChange(patch);
      return;
    }

    onValuesChange({
      ...patch,
      [STREET_TO_POSTAL_FIELD_MAP[field]]: value,
    });
  }

  function handleSameAsPhysicalChange(checked: boolean) {
    if (readOnly) return;

    onSameAsPhysicalChange(checked);

    if (checked) {
      onValuesChange(copyStreetAddressToPostal(streetValues));
    }
  }

  function handlePostalPatch(patch: Partial<MemberAddressValues>) {
    if (readOnly) return;

    onValuesChange(patch);
  }

  const physicalFields = (
    <div className="space-y-3">
      {physicalDescription}
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-streetAddressLine1`}>Address line 1</Label>
        <AddressAutocomplete
          addressParams={{ post_box: "0" }}
          className={readOnlyInputClassName}
          disabled={disabled}
          id={`${idPrefix}-streetAddressLine1`}
          maxLength={200}
          onAddressSelected={(selection) =>
            applyStreetPatch({
              streetAddressLine1: selection.addressLine1,
              streetAddressLine2: selection.addressLine2,
              streetCity: selection.city,
              streetRegion: selection.region,
              streetPostalCode: selection.postalCode,
              streetCountry: selection.country,
            })
          }
          onChange={(nextValue) =>
            handleStreetFieldChange("streetAddressLine1", nextValue)
          }
          placeholder="Start typing an NZ address"
          readOnly={readOnly}
          required={required}
          value={values.streetAddressLine1}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-streetAddressLine2`}>Address line 2</Label>
        <Input
          className={readOnlyInputClassName}
          disabled={disabled}
          id={`${idPrefix}-streetAddressLine2`}
          maxLength={200}
          onChange={(event) =>
            handleStreetFieldChange(
              "streetAddressLine2",
              event.target.value,
            )
          }
          placeholder="Apartment, unit, level, or building"
          readOnly={readOnly}
          value={values.streetAddressLine2}
        />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-streetCity`}>City / town</Label>
          <Input
            className={readOnlyInputClassName}
            disabled={disabled}
            id={`${idPrefix}-streetCity`}
            maxLength={200}
            onChange={(event) =>
              handleStreetFieldChange("streetCity", event.target.value)
            }
            placeholder="City / town"
            readOnly={readOnly}
            required={required}
            value={values.streetCity}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-streetRegion`}>Region</Label>
          <Input
            className={readOnlyInputClassName}
            disabled={disabled}
            id={`${idPrefix}-streetRegion`}
            maxLength={200}
            onChange={(event) =>
              handleStreetFieldChange("streetRegion", event.target.value)
            }
            placeholder="Region"
            readOnly={readOnly}
            required={required}
            value={values.streetRegion}
          />
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-streetPostalCode`}>Postal code</Label>
          <Input
            className={readOnlyInputClassName}
            disabled={disabled}
            id={`${idPrefix}-streetPostalCode`}
            maxLength={20}
            onChange={(event) =>
              handleStreetFieldChange(
                "streetPostalCode",
                event.target.value,
              )
            }
            placeholder="Postal code"
            readOnly={readOnly}
            required={required}
            value={values.streetPostalCode}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-streetCountry`}>Country</Label>
          <Input
            className={readOnlyInputClassName}
            disabled={disabled}
            id={`${idPrefix}-streetCountry`}
            maxLength={100}
            onChange={(event) =>
              handleStreetFieldChange("streetCountry", event.target.value)
            }
            placeholder="Country"
            readOnly={readOnly}
            required={required}
            value={values.streetCountry}
          />
        </div>
      </div>
    </div>
  );

  const postalFields = sameAsPhysical ? (
    <p className="text-xs text-muted-foreground">
      Postal address will be copied from the physical address when you save.
    </p>
  ) : (
    <div className="space-y-3">
      {postalDescription}
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-postalAddressLine1`}>Address line 1</Label>
        <AddressAutocomplete
          className={readOnlyInputClassName}
          disabled={disabled}
          id={`${idPrefix}-postalAddressLine1`}
          maxLength={200}
          onAddressSelected={(selection) =>
            handlePostalPatch({
              postalAddressLine1: selection.addressLine1,
              postalAddressLine2: selection.addressLine2,
              postalCity: selection.city,
              postalRegion: selection.region,
              postalPostalCode: selection.postalCode,
              postalCountry: selection.country,
            })
          }
          onChange={(nextValue) =>
            handlePostalPatch({ postalAddressLine1: nextValue })
          }
          placeholder="Start typing an NZ postal address"
          readOnly={readOnly}
          required={required}
          value={values.postalAddressLine1}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-postalAddressLine2`}>Address line 2</Label>
        <Input
          className={readOnlyInputClassName}
          disabled={disabled}
          id={`${idPrefix}-postalAddressLine2`}
          maxLength={200}
          onChange={(event) =>
            handlePostalPatch({ postalAddressLine2: event.target.value })
          }
          placeholder="Apartment, unit, level, or building"
          readOnly={readOnly}
          value={values.postalAddressLine2}
        />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-postalCity`}>City / town</Label>
          <Input
            className={readOnlyInputClassName}
            disabled={disabled}
            id={`${idPrefix}-postalCity`}
            maxLength={200}
            onChange={(event) =>
              handlePostalPatch({ postalCity: event.target.value })
            }
            placeholder="City / town"
            readOnly={readOnly}
            required={required}
            value={values.postalCity}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-postalRegion`}>Region</Label>
          <Input
            className={readOnlyInputClassName}
            disabled={disabled}
            id={`${idPrefix}-postalRegion`}
            maxLength={200}
            onChange={(event) =>
              handlePostalPatch({ postalRegion: event.target.value })
            }
            placeholder="Region"
            readOnly={readOnly}
            required={required}
            value={values.postalRegion}
          />
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-postalPostalCode`}>Postal code</Label>
          <Input
            className={readOnlyInputClassName}
            disabled={disabled}
            id={`${idPrefix}-postalPostalCode`}
            maxLength={20}
            onChange={(event) =>
              handlePostalPatch({ postalPostalCode: event.target.value })
            }
            placeholder="Postal code"
            readOnly={readOnly}
            required={required}
            value={values.postalPostalCode}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`${idPrefix}-postalCountry`}>Country</Label>
          <Input
            className={readOnlyInputClassName}
            disabled={disabled}
            id={`${idPrefix}-postalCountry`}
            maxLength={100}
            onChange={(event) =>
              handlePostalPatch({ postalCountry: event.target.value })
            }
            placeholder="Country"
            readOnly={readOnly}
            required={required}
            value={values.postalCountry}
          />
        </div>
      </div>
    </div>
  );

  const postalCheckbox = (
    <div className="flex items-center gap-2 pb-1">
      <Checkbox
        checked={sameAsPhysical}
        disabled={disabled || readOnly}
        id={`${idPrefix}-sameAsPhysical`}
        onCheckedChange={(checked) =>
          handleSameAsPhysicalChange(checked === true)
        }
      />
      <Label
        className="cursor-pointer text-sm font-normal"
        htmlFor={`${idPrefix}-sameAsPhysical`}
      >
        Postal same as physical
      </Label>
    </div>
  );

  if (collapsible) {
    return (
      <Accordion
        className={cn("rounded-lg border px-4", className)}
        defaultValue={sameAsPhysical ? ["physical"] : ["physical", "postal"]}
        type="multiple"
      >
        <AccordionItem value="physical">
          <AccordionTrigger>Physical address</AccordionTrigger>
          <AccordionContent>{physicalFields}</AccordionContent>
        </AccordionItem>
        <AccordionItem value="postal" className="border-b-0">
          <AccordionTrigger>Postal address</AccordionTrigger>
          <AccordionContent>
            <div className="space-y-3">
              {postalCheckbox}
              {postalFields}
            </div>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    );
  }

  return (
    <div className={cn("space-y-5", className)}>
      <fieldset className="space-y-3 rounded-lg border p-4">
        <legend className="px-1 text-sm font-medium">Physical address</legend>
        {physicalFields}
      </fieldset>

      <fieldset className="space-y-3 rounded-lg border p-4">
        <legend className="px-1 text-sm font-medium">Postal address</legend>
        {postalCheckbox}
        {postalFields}
      </fieldset>
    </div>
  );
}
