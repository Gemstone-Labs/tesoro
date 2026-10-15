/**
 * DRAFT PENDING LEGAL REVIEW. The Terms and Privacy Policy were written in-house for Gemstone Labs, Inc. and have not been
 * reviewed by a lawyer. Do not remove this note, and do not show it to Players, before counsel signs off.
 *
 * Every bracketed value below is a placeholder the founder must fill before mainnet launch.
 */
export const ENTITY = {
  name: "Gemstone Labs, Inc.",
  product: "Tesoro",
  form: "a Delaware corporation",
  address: "[REGISTERED ADDRESS]",
  contactEmail: "[CONTACT EMAIL]",
  privacyEmail: "[PRIVACY EMAIL]",
  effectiveDate: "[EFFECTIVE DATE]",
  minAge: 18,
} as const;

/** Placeholders still to fill, for tests and for the launch checklist. */
export const LEGAL_PLACEHOLDERS = [ENTITY.address, ENTITY.contactEmail, ENTITY.privacyEmail, ENTITY.effectiveDate] as const;
