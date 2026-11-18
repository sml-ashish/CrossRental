import {
  Checkbox,
  Field,
  Select,
  TextArea,
  TextInput,
} from "@/components/ui/form";
import {
  RATE_BASIS_OPTIONS,
  TAX_BASIS_OPTIONS,
} from "@/lib/negotiation-display";
import type { OfferFields } from "@/lib/negotiations";

/**
 * The structured terms of a counter-offer, shared by the SML and vendor dialogs.
 *
 * Numeric values are held as strings so a partially typed value is preserved;
 * the parent parses them when it previews or submits. No total is ever entered
 * here — the server computes it from these terms.
 */
export interface OfferFormValues {
  rentalRate: string;
  rateBasis: string;
  mobilisationCharges: string;
  demobilisationCharges: string;
  taxBasis: string;
  validityDate: string;
  availableFrom: string;
  availabilityConfirmed: boolean;
  deviationText: string;
  message: string;
}

export function emptyOfferForm(overrides: Partial<OfferFormValues> = {}): OfferFormValues {
  return {
    rentalRate: "",
    rateBasis: "PER_MONTH",
    mobilisationCharges: "0",
    demobilisationCharges: "0",
    taxBasis: "EXCLUSIVE_OF_GST",
    validityDate: "",
    availableFrom: "",
    availabilityConfirmed: true,
    deviationText: "",
    message: "",
    ...overrides,
  };
}

export function OfferFieldsForm({
  prefix,
  values,
  onChange,
  disableTerms = false,
  errorFor,
  availabilityLabel = "Crane is available for the full required duration",
}: {
  /** Unique id prefix so two dialogs on one page never share input ids. */
  prefix: string;
  values: OfferFormValues;
  onChange: (patch: Partial<OfferFormValues>) => void;
  /** Locks every term except the message (used by the accept flow, if reused). */
  disableTerms?: boolean;
  errorFor?: (field: string) => string | undefined;
  availabilityLabel?: string;
}) {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <Field
          label="Rental rate"
          htmlFor={`${prefix}-rate`}
          required
          error={errorFor?.("rentalRate")}
        >
          <TextInput
            id={`${prefix}-rate`}
            type="number"
            inputMode="decimal"
            value={values.rentalRate}
            onChange={(value) => onChange({ rentalRate: value })}
            disabled={disableTerms}
            invalid={Boolean(errorFor?.("rentalRate"))}
          />
        </Field>
        <Field label="Rate basis" htmlFor={`${prefix}-basis`} required>
          <Select
            id={`${prefix}-basis`}
            value={values.rateBasis}
            onChange={(value) => onChange({ rateBasis: value })}
            options={RATE_BASIS_OPTIONS}
            disabled={disableTerms}
          />
        </Field>
        <Field
          label="Tax basis"
          htmlFor={`${prefix}-tax`}
          hint="For comparison only; it does not change the total."
        >
          <Select
            id={`${prefix}-tax`}
            value={values.taxBasis}
            onChange={(value) => onChange({ taxBasis: value })}
            options={TAX_BASIS_OPTIONS}
            disabled={disableTerms}
          />
        </Field>
        <Field
          label="Mobilisation charges"
          htmlFor={`${prefix}-mob`}
          error={errorFor?.("mobilisationCharges")}
        >
          <TextInput
            id={`${prefix}-mob`}
            type="number"
            inputMode="decimal"
            value={values.mobilisationCharges}
            onChange={(value) => onChange({ mobilisationCharges: value })}
            disabled={disableTerms}
            invalid={Boolean(errorFor?.("mobilisationCharges"))}
          />
        </Field>
        <Field
          label="Demobilisation charges"
          htmlFor={`${prefix}-demob`}
          error={errorFor?.("demobilisationCharges")}
        >
          <TextInput
            id={`${prefix}-demob`}
            type="number"
            inputMode="decimal"
            value={values.demobilisationCharges}
            onChange={(value) => onChange({ demobilisationCharges: value })}
            disabled={disableTerms}
            invalid={Boolean(errorFor?.("demobilisationCharges"))}
          />
        </Field>
        <Field
          label="Offer valid until"
          htmlFor={`${prefix}-validity`}
          required
          error={errorFor?.("validityDate")}
        >
          <TextInput
            id={`${prefix}-validity`}
            type="date"
            value={values.validityDate}
            onChange={(value) => onChange({ validityDate: value })}
            disabled={disableTerms}
            invalid={Boolean(errorFor?.("validityDate"))}
          />
        </Field>
      </div>

      <Checkbox
        id={`${prefix}-available-flag`}
        checked={values.availabilityConfirmed}
        onChange={(value) => onChange({ availabilityConfirmed: value })}
        label={availabilityLabel}
        disabled={disableTerms}
      />
      {errorFor?.("availabilityConfirmed") ? (
        <p className="text-xs font-medium text-red-600">
          {errorFor("availabilityConfirmed")}
        </p>
      ) : null}

      <Field
        label="Deviation / notes (optional)"
        htmlFor={`${prefix}-deviation`}
        hint="Any assumption or exception attached to this offer."
      >
        <TextArea
          id={`${prefix}-deviation`}
          value={values.deviationText}
          onChange={(value) => onChange({ deviationText: value })}
          rows={2}
          disabled={disableTerms}
        />
      </Field>

      <Field
        label="Message (optional)"
        htmlFor={`${prefix}-message`}
        hint="Shown with this offer in the negotiation thread."
      >
        <TextArea
          id={`${prefix}-message`}
          value={values.message}
          onChange={(value) => onChange({ message: value })}
          rows={2}
        />
      </Field>
    </div>
  );
}

/** Convert the form's string values into the numeric offer the API expects. */
export function toOfferFields(values: OfferFormValues): OfferFields {
  return {
    rentalRate: Number(values.rentalRate),
    rateBasis: values.rateBasis as OfferFields["rateBasis"],
    mobilisationCharges: Number(values.mobilisationCharges || 0),
    demobilisationCharges: Number(values.demobilisationCharges || 0),
    taxBasis: values.taxBasis as OfferFields["taxBasis"],
    validityDate: values.validityDate,
    availableFrom: values.availableFrom || null,
    availabilityConfirmed: values.availabilityConfirmed,
    deviationText: values.deviationText || null,
    message: values.message || null,
  };
}
