import { z } from "zod";
import { isoDateTime, optionalText, pageQuery, paise, trimmed, uuid } from "./common";

// Central service catalogue + pricing, and audited branch price overrides (PRD 2.5, 4.1).

export const createServiceCategoryRequest = z.object({
  name: trimmed(80),
  sortOrder: z.number().int().min(0).max(10_000).default(0),
});
export type CreateServiceCategoryRequest = z.infer<typeof createServiceCategoryRequest>;

/** PATCH: defaults stripped so absent keys stay absent. */
export const updateServiceCategoryRequest = createServiceCategoryRequest.partial().extend({
  sortOrder: z.number().int().min(0).max(10_000).optional(),
  active: z.boolean().optional(),
});
export type UpdateServiceCategoryRequest = z.infer<typeof updateServiceCategoryRequest>;

export const serviceCategoryResponse = z.object({
  id: uuid,
  name: z.string(),
  sortOrder: z.number().int(),
  active: z.boolean(),
});
export type ServiceCategoryResponse = z.infer<typeof serviceCategoryResponse>;

/** Stored upper-case (DB CHECK). */
export const serviceCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9][A-Z0-9_-]{1,31}$/, "2-32 chars: letters, digits, _ or -");

export const createServiceRequest = z.object({
  code: serviceCode,
  name: trimmed(160),
  description: optionalText(2000),
  categoryId: uuid.optional(),
  durationMin: z.number().int().min(5).max(600),
  basePricePaise: paise,
  taxable: z.boolean().default(false),
});
export type CreateServiceRequest = z.infer<typeof createServiceRequest>;

/** PATCH: defaults stripped so absent keys stay absent; `categoryId: null` clears the category. */
export const updateServiceRequest = createServiceRequest.partial().extend({
  categoryId: uuid.nullable().optional(),
  taxable: z.boolean().optional(),
  active: z.boolean().optional(),
});
export type UpdateServiceRequest = z.infer<typeof updateServiceRequest>;

export const listServicesQuery = pageQuery.extend({
  q: z.string().trim().max(100).optional(),
  categoryId: uuid.optional(),
  active: z.stringbool().optional(),
  /** When set, responses include `effectivePricePaise` for this branch. */
  branchId: uuid.optional(),
});
export type ListServicesQuery = z.infer<typeof listServicesQuery>;

export const serviceResponse = z.object({
  id: uuid,
  code: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  categoryId: uuid.nullable(),
  durationMin: z.number().int(),
  basePricePaise: z.number().int(),
  taxable: z.boolean(),
  active: z.boolean(),
  effectivePricePaise: z.number().int().optional(),
});
export type ServiceResponse = z.infer<typeof serviceResponse>;

/** Closes any open override for (service, branch) and opens a new one. Requires `price:override` on the branch. */
export const setPriceOverrideRequest = z.object({
  branchId: uuid,
  pricePaise: paise,
  reason: trimmed(500).min(3),
  effectiveFrom: isoDateTime.optional(),
});
export type SetPriceOverrideRequest = z.infer<typeof setPriceOverrideRequest>;

/** Ends the open override; the branch reverts to the central price. */
export const clearPriceOverrideRequest = z.object({
  branchId: uuid,
  reason: trimmed(500).min(3),
});
export type ClearPriceOverrideRequest = z.infer<typeof clearPriceOverrideRequest>;

export const priceOverrideResponse = z.object({
  id: uuid,
  serviceId: uuid,
  branchId: uuid,
  pricePaise: z.number().int(),
  reason: z.string(),
  setBy: z.string(),
  effectiveFrom: isoDateTime,
  effectiveTo: isoDateTime.nullable(),
});
export type PriceOverrideResponse = z.infer<typeof priceOverrideResponse>;

export const effectivePriceResponse = z.object({
  serviceId: uuid,
  branchId: uuid,
  pricePaise: z.number().int(),
  source: z.enum(["BASE", "OVERRIDE"]),
  overrideId: uuid.nullable(),
});
export type EffectivePriceResponse = z.infer<typeof effectivePriceResponse>;
