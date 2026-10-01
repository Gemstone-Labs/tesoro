import { LANDING_ART } from "./art.generated";

export type LandingAsset = { w: number; h: number; widths: number[] };

export type LandingKey =
  | "heroBack" | "heroMid" | "heroFront" | "heroMobile"
  | "himGuide" | "herBacker"
  | "finalBack" | "finalDuo" | "finalMobile"
  | "step1" | "step2" | "step3" | "step4" | "step5"
  | "multichain" | "multichainMobile"
  | "textureDark" | "textureLight";

/** Astra's art for the landing page, or undefined until it is delivered and imported. */
export const landingArt = (key: LandingKey): LandingAsset | undefined => LANDING_ART[key];

export const srcSet = (key: LandingKey, asset: LandingAsset, format: "avif" | "webp") =>
  asset.widths.map((w) => `/art/landing/${key}-${w}.${format} ${w}w`).join(", ");

export const largestSrc = (key: LandingKey, asset: LandingAsset) =>
  `/art/landing/${key}-${asset.widths[asset.widths.length - 1]}.webp`;
