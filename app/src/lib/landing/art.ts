import { LANDING_ART } from "./art.generated";

export type LandingAsset = { w: number; h: number; widths: number[] };

export type LandingKey =
  | "heroBack" | "heroMid" | "heroFront" | "heroMobile" | "heroLight" | "heroLightMobile"
  | "himGuide" | "herBacker"
  | "finalBack" | "finalDuo" | "finalRope" | "finalMobile"
  | "step1" | "step2" | "step3" | "step4" | "step5";

/** Astra's art for the landing page, or undefined until it is delivered and imported. */
export const landingArt = (key: LandingKey): LandingAsset | undefined => LANDING_ART[key];

export const srcSet = (key: LandingKey, asset: LandingAsset, format: "avif" | "webp") =>
  asset.widths.map((w) => `/art/landing/${key}-${w}.${format} ${w}w`).join(", ");

export const largestSrc = (key: LandingKey, asset: LandingAsset) =>
  `/art/landing/${key}-${asset.widths[asset.widths.length - 1]}.webp`;
