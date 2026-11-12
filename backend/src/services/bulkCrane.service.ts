import { prisma } from "../lib/database";
import { AppError } from "../middleware/errorHandler";
import type { AuthedRequest } from "../middleware/auth";
import { can } from "../utils/rbac";
import { tryGeocode } from "../lib/geo";
import { readMapsCell } from "../lib/googleMapsLink";
import { parseCraneSheet, SHEET_COLUMNS } from "../lib/craneSheet";
import { buildCraneTemplate } from "../lib/craneTemplate";
import { createCraneSchema } from "../validation/craneFields";
import { createCrane, resolveImportTarget, type Actor } from "./crane.service";
import { recordAudit } from "./audit.service";
import { CraneStatus } from "../generated/prisma/client";

/**
 * Bulk crane upload for a vendor (sales and admin).
 *
 * The whole point of this file is that it is **not a second way to create a
 * crane**. Each row is turned into the payload the single-crane form would send
 * and handed to `createCrane`, so capacity, year, serial, status, geocoding,
 * approval and audit rules cannot drift between the two entry points.
 *
 * Three things are specific to the bulk path:
 *
 * - **The vendor is chosen once**, before the sheet is read, and every row
 *   belongs to them. There is no vendor column, so a sheet cannot be used to
 *   write into someone else's fleet.
 * - **A bad row does not stop the import.** The valid rows land and the report
 *   names the row number and the field that failed; `dryRun` returns the same
 *   report without writing anything.
 * - **One notification per import.** `createCrane` is asked not to mail the
 *   vendor per row; a single summary mail goes out once the import finishes.
 *
 * Duplicates are reported, never merged: a serial already on the vendor's active
 * fleet, or repeated earlier in the same file, is skipped. Silently updating an
 * existing crane from a spreadsheet is a different, far more dangerous feature.
 */

const STATUS_BY_LABEL = new Map<string, CraneStatus>([
  ["available", CraneStatus.AVAILABLE],
  ["engaged", CraneStatus.ENGAGED],
  ["booked", CraneStatus.BOOKED],
  ["hired", CraneStatus.HIRED],
  ["undermaintenance", CraneStatus.UNDER_MAINTENANCE],
  ["maintenance", CraneStatus.UNDER_MAINTENANCE],
  ["underrepair", CraneStatus.UNDER_MAINTENANCE],
]);

const FIELD_LABELS = new Map(
  SHEET_COLUMNS.map((column) => [column.key, column.label] as const),
);

export interface BulkRowResult {
  /** Excel row number, so the report points at the line to fix. */
  row: number;
  serial: string | null;
  /** `valid` is the dry-run equivalent of `imported`. */
  status: "imported" | "valid" | "skipped" | "failed";
  message: string | null;
  warnings: string[];
}

export interface BulkImportResult {
  dryRun: boolean;
  summary: {
    total: number;
    imported: number;
    /** Rows that would import in a dry run; 0 once the import has run. */
    valid: number;
    skipped: number;
    failed: number;
    /** Rows that imported (or would import) without a confirmed location. */
    unlocated: number;
  };
  rows: BulkRowResult[];
}

function assertCanImport(actor: Actor): void {
  if (actor.role === "vendor_user" || !can(actor.role, "fleet:edit_all")) {
    throw AppError.forbidden(
      "Only SML sales and admin users can upload a vendor's cranes",
    );
  }
}

function normalise(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Maps a typed label or code onto the stored code for a reference list. */
function resolveReference(
  raw: string | undefined,
  entries: Array<{ code: string; name: string }>,
): string | null {
  const text = (raw ?? "").trim();
  if (!text) return null;
  const wanted = normalise(text);
  const match = entries.find(
    (entry) =>
      normalise(entry.code) === wanted || normalise(entry.name) === wanted,
  );
  return match?.code ?? null;
}

/**
 * `createCraneSchema` reports issues per field; the report needs a sentence a
 * sales user can map back to a column.
 */
function describeIssues(
  issues: ReadonlyArray<{ path: readonly PropertyKey[]; message: string }>,
): string {
  return issues
    .slice(0, 3)
    .map((issue) => {
      const field = String(issue.path[0] ?? "");
      return `${FIELD_LABELS.get(field) ?? field}: ${issue.message}`;
    })
    .join(" · ");
}

export async function craneImportTemplate(actor: Actor): Promise<Buffer> {
  assertCanImport(actor);
  const [craneTypes, states] = await Promise.all([
    prisma.craneType.findMany({
      select: { code: true, name: true },
      orderBy: { sortOrder: "asc" },
    }),
    prisma.state.findMany({
      select: { code: true, name: true },
      orderBy: { name: "asc" },
    }),
  ]);
  return buildCraneTemplate({ craneTypes, states });
}

export async function importCranes(input: {
  actor: Actor;
  vendorId: string;
  buffer: Buffer;
  dryRun: boolean;
}): Promise<BulkImportResult> {
  const { actor, buffer, dryRun } = input;
  assertCanImport(actor);

  const vendorId = (input.vendorId ?? "").trim();
  if (!vendorId) {
    throw AppError.badRequest("Choose the vendor whose fleet you are uploading");
  }
  // Reuses the single-crane path's rule: the vendor must exist and be Approved.
  const target = await resolveImportTarget(actor, vendorId);

  const rows = await parseCraneSheet(buffer);

  const [craneTypes, states, existingCranes] = await Promise.all([
    prisma.craneType.findMany({ select: { code: true, name: true } }),
    prisma.state.findMany({ select: { code: true, name: true } }),
    prisma.crane.findMany({
      where: { vendorId: target.vendorId, isActive: true },
      select: { serialRegistrationNo: true },
    }),
  ]);

  const serialsOnFile = new Set(
    existingCranes.map((crane) => crane.serialRegistrationNo.toLowerCase()),
  );

  const results: BulkRowResult[] = [];
  let imported = 0;
  let valid = 0;
  let skipped = 0;
  let failed = 0;
  let unlocated = 0;

  for (const row of rows) {
    const values = row.values;
    const serial = (values["serialRegistrationNo"] ?? "").trim() || null;
    const warnings: string[] = [];

    const fail = (message: string): void => {
      failed += 1;
      results.push({ row: row.rowNumber, serial, status: "failed", message, warnings });
    };

    if (!values["pincode"]?.trim()) {
      fail(
        "Pincode: enter the six-digit pincode — it is required so the crane can be located when the Google Maps cell is empty",
      );
      continue;
    }

    const typeCode = resolveReference(values["typeOfCraneCode"], craneTypes);
    if (!typeCode) {
      fail(
        `Crane type: “${values["typeOfCraneCode"] ?? ""}” is not one of the types on the Lists sheet`,
      );
      continue;
    }

    const stateCode = resolveReference(values["stateCode"], states);
    if (!stateCode) {
      fail(
        `State: “${values["stateCode"] ?? ""}” is not an Indian state on the Lists sheet`,
      );
      continue;
    }

    // A row cannot ask for a status the portal sets itself.
    let status: CraneStatus | undefined;
    const statusText = (values["currentStatus"] ?? "").trim();
    if (statusText) {
      status = STATUS_BY_LABEL.get(normalise(statusText));
      if (!status) {
        fail(
          `Status: “${statusText}” is not Available, Engaged or Under Maintenance`,
        );
        continue;
      }
      if (status === CraneStatus.BOOKED || status === CraneStatus.HIRED) {
        fail(
          `Status: ${statusText} is set by the portal when a crane is awarded, not in an upload`,
        );
        continue;
      }
    }

    // --- location ---------------------------------------------------------
    // Coordinates in the Maps cell win; then its place name; then the pincode
    // fallback, which `createCrane` performs from location + state + pincode.
    let latitude: number | undefined;
    let longitude: number | undefined;
    const maps = await readMapsCell(values["googleMapsLocation"] ?? "");
    if (maps.point) {
      latitude = maps.point.lat;
      longitude = maps.point.lng;
    } else if (maps.query) {
      const lookup = await tryGeocode({
        location: maps.query,
        state: stateCode,
        pincode: values["pincode"],
      });
      if (lookup.ok) {
        latitude = lookup.point.lat;
        longitude = lookup.point.lng;
        warnings.push("Located from the Google Maps cell");
      } else {
        warnings.push(
          `The Google Maps location could not be resolved (${lookup.reason}); the pincode was used instead`,
        );
      }
    } else if (maps.note) {
      warnings.push(`${maps.note}; the pincode was used instead`);
    }

    const candidate = {
      vendorId: target.vendorId,
      serialRegistrationNo: values["serialRegistrationNo"] ?? "",
      typeOfCraneCode: typeCode,
      capacityT: values["capacityT"],
      currentLocation: values["currentLocation"],
      stateCode,
      pincode: values["pincode"],
      make: values["make"],
      model: values["model"],
      yom: values["yom"],
      mainBoomM: values["mainBoomM"],
      fixedJibM: values["fixedJibM"] ?? null,
      luffingJibM: values["luffingJibM"] ?? null,
      windJibM: values["windJibM"] ?? null,
      currentStatus: status,
      availableFrom: values["availableFrom"] ?? null,
      expectedReadyDate: values["expectedReadyDate"] ?? null,
      remarks: values["remarks"] ?? null,
      latitude,
      longitude,
    };

    const parsed = createCraneSchema.safeParse(candidate);
    if (!parsed.success) {
      fail(describeIssues(parsed.error.issues));
      continue;
    }

    const serialKey = (values["serialRegistrationNo"] ?? "").trim().toLowerCase();
    if (!serialKey) {
      fail("Serial / registration no: enter the serial number");
      continue;
    }
    if (serialsOnFile.has(serialKey)) {
      skipped += 1;
      results.push({
        row: row.rowNumber,
        serial,
        status: "skipped",
        message: "A crane with this serial is already on this vendor's fleet",
        warnings,
      });
      continue;
    }

    // Record it now so a repeat of the same serial later in the file is caught,
    // whether or not this row is actually written.
    serialsOnFile.add(serialKey);

    if (dryRun) {
      valid += 1;
      if (latitude === undefined || longitude === undefined) unlocated += 1;
      results.push({
        row: row.rowNumber,
        serial,
        status: "valid",
        message:
          latitude === undefined
            ? "No usable location — it will be added as location unverified"
            : null,
        warnings,
      });
      continue;
    }

    try {
      const created = await createCrane(candidate, actor);
      imported += 1;
      if (created.latitude === null) unlocated += 1;
      results.push({
        row: row.rowNumber,
        serial,
        status: "imported",
        message: created.latitude === null
          ? "Added without a location — it shows as location unverified"
          : null,
        warnings,
      });
    } catch (error) {
      if (error instanceof AppError && error.statusCode === 409) {
        skipped += 1;
        results.push({
          row: row.rowNumber,
          serial,
          status: "skipped",
          message: error.message,
          warnings,
        });
        continue;
      }
      fail(error instanceof Error ? error.message : "The crane could not be saved");
    }
  }

  if (!dryRun && imported > 0) {
    await recordAudit({
      entity: "vendor",
      entityId: target.vendorId,
      action: "crane_bulk_import",
      newValue: {
        imported,
        skipped,
        failed,
        rows: results.length,
        source: "xlsx",
      },
      actor: {
        id: actor.id,
        email: actor.email,
        role: actor.role,
        vendorId: actor.vendorId,
      } as AuthedRequest["user"],
      onBehalfOfVendor: true,
    });
  }

  return {
    dryRun,
    summary: {
      total: results.length,
      imported,
      valid,
      skipped,
      failed,
      unlocated,
    },
    rows: results,
  };
}
