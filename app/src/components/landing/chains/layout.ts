/** Scene positions for the multichain stage, wide (desktop) and tall (phone). Shared by the canvas and the DOM labels. */
export type ChainsLayout = "wide" | "tall";

type V3 = [number, number, number];

export const CHAINS: { label: string; color: string; at: Record<ChainsLayout, V3> }[] = [
  { label: "SOL", color: "#3ff0c4", at: { wide: [-3.4, 1.3, 0], tall: [-1.15, 1.5, 0] } },
  { label: "ETH", color: "#a8c8d6", at: { wide: [-3.75, -0.05, 0], tall: [0, 1.8, 0] } },
  { label: "HYPE", color: "#8ff7e4", at: { wide: [-3.4, -1.4, 0], tall: [1.15, 1.5, 0] } },
];

export const LEDGER: Record<ChainsLayout, V3> = { wide: [2.5, 0, 0], tall: [0, -1.55, 0] };

export const CAMERA = { fov: 30, z: { wide: 9, tall: 9.6 } } as const;
export const ASPECT: Record<ChainsLayout, number> = { wide: 2.4, tall: 0.78 };

/** Where a scene point lands in the stage, as percentages (for the HTML chain labels over canvas or poster). */
export function toStage([x, y]: V3, layout: ChainsLayout): { left: string; top: string } {
  const halfH = Math.tan(((CAMERA.fov / 2) * Math.PI) / 180) * CAMERA.z[layout];
  const halfW = halfH * ASPECT[layout];
  return { left: `${((x / halfW + 1) / 2) * 100}%`, top: `${((1 - y / halfH) / 2) * 100}%` };
}
