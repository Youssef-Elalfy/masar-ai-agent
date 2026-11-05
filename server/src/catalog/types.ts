import { z } from 'zod';

/** Validated shape for inserting a company package. Adding a destination = one row of this. */
export const PackageInputSchema = z.object({
  id: z.string().min(1),
  slug: z.string().regex(/^[a-z0-9-]+$/),
  destination: z.string().min(1),
  destination_ar: z.string().min(1).nullable().default(null),
  country: z.string().min(1),
  type: z.string().min(1),
  name_en: z.string().min(1).nullable().default(null),
  name_ar: z.string().min(1),
  days: z.number().int().positive(),
  nights: z.number().int().nonnegative(),
  price_per_person: z.number().nonnegative(),
  currency: z.string().length(3),
  pricing_basis: z.string().min(1),
  departure_city: z.string().nullable().default(null),
  source_type: z.enum(['company_demo', 'company_verified']).default('company_demo'),
  status: z.string().min(1),
  booking_enabled: z.boolean().default(false),
  included_ar: z.array(z.string()).default([]),
  excluded_ar: z.array(z.string()).default([]),
  itinerary_ar: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  disclaimer_ar: z.string().min(1),
});
export type PackageInput = z.input<typeof PackageInputSchema>;

export interface CompanyPackage {
  id: string;
  slug: string;
  destination: string;
  destinationAr: string | null;
  country: string;
  tripType: string;
  nameEn: string | null;
  nameAr: string;
  days: number;
  nights: number;
  price: { amount: number; currency: string; basis: string };
  departureCity: string | null;
  sourceType: 'company_demo' | 'company_verified';
  status: string;
  bookingEnabled: boolean;
  inclusions: string[];
  exclusions: string[];
  itinerary: string[];
  tags: string[];
  disclaimer: string;
  updatedAt: string;
}

export interface Departure {
  id: string;
  packageId: string;
  departureDate: string;
  origin: string | null;
  availabilityStatus: string;
  seatsRemaining: number | null;
  verifiedAt: string | null;
  provider: string | null;
}

export interface PackageFilters {
  text?: string;
  tripType?: string;
  country?: string;
  /** ISO currency; required whenever a price filter is applied (never compare across currencies). */
  currency?: string;
  maxPricePerPerson?: number;
  minDays?: number;
  maxDays?: number;
  sortBy?: 'price_asc' | 'price_desc' | 'days_asc' | 'days_desc';
  limit?: number;
}
