"use client";
import { useEffect, useState } from "react";
import { getChain } from "./client";
import { deliveryTermsPda } from "./eth";
import { parseDeliveryTerms, type DeliveryTerms } from "./delivery-fee";

/** The Delivery Fee terms of each vault, read from the bridge. A vault with no terms (or before the read) is absent from the map: no fee line is shown. */
export function useDeliveryTerms(vaults: string[]): Map<string, DeliveryTerms> {
  const key = [...new Set(vaults.map((v) => v.toLowerCase()))].sort().join(",");
  const [terms, setTerms] = useState<Map<string, DeliveryTerms>>(new Map());
  useEffect(() => {
    let live = true;
    const list = key ? key.split(",") : [];
    void (async () => {
      const next = new Map<string, DeliveryTerms>();
      for (const vault of list) {
        try {
          const info = await getChain().base.getAccountInfo(deliveryTermsPda(vault), "confirmed");
          const parsed = info ? parseDeliveryTerms(info.data) : null;
          if (parsed) next.set(vault, parsed);
        } catch {
          /* no fee line until the read succeeds */
        }
      }
      if (live) setTerms(next);
    })();
    return () => {
      live = false;
    };
  }, [key]);
  return terms;
}
