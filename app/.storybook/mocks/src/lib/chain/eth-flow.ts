// Storybook: relayed steps never finish (the Opening tracker shows its step note), or fail when the story says so.
import { screenData } from "../../../../../stories/screens/support/screen";

export * from "../../../../../src/lib/chain/eth-flow";

const never = <T>() => new Promise<T>(() => {});
const settle = <T>() => (screenData().eth?.opening === "failed" ? Promise.reject(new Error("The Hoodi transaction reverted.")) : never<T>());

export const ethCall = <T = Record<string, unknown>>() => settle<T>();
export const takeEthAdvance = () => settle<string>();
export const fetchEthPrice = async (asset: "ETH" | "HYPE" = "ETH") => ({ priceMicroUsd: asset === "HYPE" ? 28_400_000n : 3_180_000_000n, live: true });
