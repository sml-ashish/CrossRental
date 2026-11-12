import { prisma } from "../lib/database";
import { AppError } from "../middleware/errorHandler";
import type { AuthedRequest } from "../middleware/auth";
import { recordAudit, diff } from "./audit.service";

/**
 * P5 admin configuration that is more than a single setting value.
 *
 * Three tables are editable here without a deploy:
 * - `mobilisation_rates` — the per-km assumptions the estimator uses.
 * - `email_templates` — the wording of every transactional email.
 * - `states.region` — the state-to-region mapping reports group on.
 *
 * Every write is audited. Bank details never pass through this service.
 */

export interface MobilisationRateRow {
  id: string;
  craneTypeCode: string;
  craneTypeName: string;
  capacityMinT: number;
  capacityMaxT: number | null;
  ownershipType: string | null;
  ratePerKm: number;
  isActive: boolean;
}

function toRateRow(row: {
  id: string;
  craneTypeCode: string;
  capacityMinT: unknown;
  capacityMaxT: unknown;
  ownershipType: string | null;
  ratePerKm: unknown;
  isActive: boolean;
  craneType: { name: string };
}): MobilisationRateRow {
  return {
    id: row.id,
    craneTypeCode: row.craneTypeCode,
    craneTypeName: row.craneType.name,
    capacityMinT: Number(row.capacityMinT),
    capacityMaxT: row.capacityMaxT === null ? null : Number(row.capacityMaxT),
    ownershipType: row.ownershipType,
    ratePerKm: Number(row.ratePerKm),
    isActive: row.isActive,
  };
}

const RATE_INCLUDE = { craneType: { select: { name: true } } } as const;

export async function listMobilisationRates(): Promise<MobilisationRateRow[]> {
  const rows = await prisma.mobilisationRate.findMany({
    include: RATE_INCLUDE,
    orderBy: [{ craneTypeCode: "asc" }, { capacityMinT: "asc" }, { ownershipType: "asc" }],
  });
  return rows.map(toRateRow);
}

export async function createMobilisationRate(
  input: {
    craneTypeCode: string;
    capacityMinT: number;
    capacityMaxT: number | null;
    ownershipType: "VENDOR" | "SML" | null;
    ratePerKm: number;
  },
  actor: AuthedRequest["user"],
): Promise<MobilisationRateRow> {
  const craneType = await prisma.craneType.findUnique({
    where: { code: input.craneTypeCode },
    select: { code: true },
  });
  if (!craneType) throw AppError.badRequest("Unknown crane category");

  const created = await prisma.mobilisationRate.create({
    data: {
      craneTypeCode: input.craneTypeCode,
      capacityMinT: input.capacityMinT,
      capacityMaxT: input.capacityMaxT,
      ownershipType: input.ownershipType,
      ratePerKm: input.ratePerKm,
    },
    include: RATE_INCLUDE,
  });

  await recordAudit({
    entity: "MobilisationRate",
    entityId: created.id,
    action: "MOBILISATION_RATE_CREATED",
    newValue: {
      craneTypeCode: created.craneTypeCode,
      capacityMinT: Number(created.capacityMinT),
      capacityMaxT: created.capacityMaxT === null ? null : Number(created.capacityMaxT),
      ownershipType: created.ownershipType,
      ratePerKm: Number(created.ratePerKm),
    },
    actor,
  });

  return toRateRow(created);
}

export async function updateMobilisationRate(
  id: string,
  input: {
    capacityMinT?: number;
    capacityMaxT?: number | null;
    ownershipType?: "VENDOR" | "SML" | null;
    ratePerKm?: number;
    isActive?: boolean;
  },
  actor: AuthedRequest["user"],
): Promise<MobilisationRateRow> {
  const before = await prisma.mobilisationRate.findUnique({ where: { id } });
  if (!before) throw AppError.notFound("Mobilisation rate not found");

  const after = await prisma.mobilisationRate.update({
    where: { id },
    data: {
      ...(input.capacityMinT !== undefined ? { capacityMinT: input.capacityMinT } : {}),
      ...(input.capacityMaxT !== undefined ? { capacityMaxT: input.capacityMaxT } : {}),
      ...(input.ownershipType !== undefined ? { ownershipType: input.ownershipType } : {}),
      ...(input.ratePerKm !== undefined ? { ratePerKm: input.ratePerKm } : {}),
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
    },
    include: RATE_INCLUDE,
  });

  const change = diff(
    {
      capacityMinT: Number(before.capacityMinT),
      capacityMaxT: before.capacityMaxT === null ? null : Number(before.capacityMaxT),
      ownershipType: before.ownershipType,
      ratePerKm: Number(before.ratePerKm),
      isActive: before.isActive,
    },
    {
      capacityMinT: Number(after.capacityMinT),
      capacityMaxT: after.capacityMaxT === null ? null : Number(after.capacityMaxT),
      ownershipType: after.ownershipType,
      ratePerKm: Number(after.ratePerKm),
      isActive: after.isActive,
    },
    ["capacityMinT", "capacityMaxT", "ownershipType", "ratePerKm", "isActive"],
  );
  if (change) {
    await recordAudit({
      entity: "MobilisationRate",
      entityId: id,
      action: "MOBILISATION_RATE_UPDATED",
      ...change,
      actor,
    });
  }

  return toRateRow(after);
}

export interface EmailTemplateRow {
  key: string;
  subject: string;
  bodyHtml: string;
  updatedAt: Date;
}

export async function listEmailTemplates(): Promise<EmailTemplateRow[]> {
  return prisma.emailTemplate.findMany({
    select: { key: true, subject: true, bodyHtml: true, updatedAt: true },
    orderBy: { key: "asc" },
  });
}

export async function updateEmailTemplate(
  key: string,
  input: { subject: string; bodyHtml: string },
  actor: AuthedRequest["user"],
): Promise<EmailTemplateRow> {
  const before = await prisma.emailTemplate.findUnique({ where: { key } });
  if (!before) throw AppError.notFound("Email template not found");

  const after = await prisma.emailTemplate.update({
    where: { key },
    data: { subject: input.subject, bodyHtml: input.bodyHtml, updatedBy: actor.id },
    select: { key: true, subject: true, bodyHtml: true, updatedAt: true },
  });

  await recordAudit({
    entity: "EmailTemplate",
    entityId: key,
    action: "EMAIL_TEMPLATE_UPDATED",
    oldValue: { subject: before.subject },
    newValue: { subject: after.subject },
    actor,
  });

  return after;
}

export interface StateRegionRow {
  code: string;
  name: string;
  region: string | null;
}

export async function listStateRegions(): Promise<StateRegionRow[]> {
  return prisma.state.findMany({
    select: { code: true, name: true, region: true },
    orderBy: { name: "asc" },
  });
}

export async function updateStateRegion(
  code: string,
  region: string | null,
  actor: AuthedRequest["user"],
): Promise<StateRegionRow> {
  const before = await prisma.state.findUnique({ where: { code } });
  if (!before) throw AppError.notFound("State not found");

  const after = await prisma.state.update({
    where: { code },
    data: { region: region?.trim() ? region.trim() : null },
    select: { code: true, name: true, region: true },
  });

  if (before.region !== after.region) {
    await recordAudit({
      entity: "State",
      entityId: code,
      action: "STATE_REGION_UPDATED",
      oldValue: { region: before.region },
      newValue: { region: after.region },
      actor,
    });
  }

  return after;
}
