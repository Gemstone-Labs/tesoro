/**
 * DRAFT PENDING LEGAL REVIEW. The Terms and Privacy Policy were written in-house for Gemstone Labs, Inc. and have not been
 * reviewed by a lawyer. Do not remove this note, and do not show it to Players, before counsel signs off.
 *
 * Every bracketed value below is a placeholder the founder must fill before mainnet launch.
 */
import { BRAND } from "../brand";

export const ENTITY = {
  name: BRAND.legalName,
  product: BRAND.name,
  form: "a Delaware corporation",
  /** Postal address for legal notices: unknown until the founders confirm it (registered agent or business address). Empty hides it. */
  address: "",
  contactEmail: "contact@playtesoro.com",
  privacyEmail: "contact@playtesoro.com",
  effectiveDate: "October 16, 2026",
  minAge: 18,
} as const;

/** Placeholders still to fill, for tests and for the launch checklist. */
export const LEGAL_PLACEHOLDERS: readonly string[] = [ENTITY.address || "[REGISTERED ADDRESS]"].filter((v) => v.startsWith("["));
