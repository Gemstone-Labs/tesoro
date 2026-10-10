"use client";

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

interface SearchState {
  query: string;
  setQuery: (q: string) => void;
}

const Ctx = createContext<SearchState>({ query: "", setQuery: () => {} });

/** The top-bar search box and the Lobby share one query: while it is set, the Lobby shows only the matching Games. */
export function SearchProvider({ children }: { children: ReactNode }) {
  const [query, setQuery] = useState("");
  const value = useMemo(() => ({ query, setQuery }), [query]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useSearch = () => useContext(Ctx);

export const matchesQuery = (name: string, query: string) => name.toLowerCase().includes(query.trim().toLowerCase());
