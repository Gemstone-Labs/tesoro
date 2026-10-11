"use client";

import dynamic from "next/dynamic";

/** PROTOTYPE: the same lazy canvas ChainsStage uses, shared with Multichain.prototype. */
export default dynamic(() => import("./ChainsCanvas"), { ssr: false });
