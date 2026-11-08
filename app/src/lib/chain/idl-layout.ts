/**
 * Field offsets of an account read in place (an Anchor `zero_copy` / bytemuck struct), computed from the IDL the program
 * build generates, so no decoder copies an offset from the Rust by hand. Only alignment-1 layouts are taken (every field
 * a byte, a byte array, or another such struct): those have no padding, so an offset is the sum of the sizes before it.
 * Anything else throws when the module loads.
 */

type IdlType = string | { array: [IdlType, number] } | { defined: { name: string } };
interface IdlTypeDef {
  name: string;
  serialization?: string;
  type: { kind: string; fields?: { name: string; type: IdlType }[] };
}
export interface IdlWithTypes {
  types?: IdlTypeDef[];
}

export interface Layout {
  /** Bytes of the struct (without the account discriminator). */
  size: number;
  /** Each field's offset inside the struct. */
  at: Record<string, number>;
}

function sizeOf(idl: IdlWithTypes, t: IdlType): number {
  if (t === "u8" || t === "i8" || t === "bool") return 1;
  if (typeof t === "string") throw new Error(`${t} is not a byte field: the layout would have padding`);
  if ("array" in t) return sizeOf(idl, t.array[0]) * t.array[1];
  return layoutOf(idl, t.defined.name).size;
}

const cache = new WeakMap<IdlWithTypes, Map<string, Layout>>();

/** The layout of IDL type `name`, which must be a bytemuck struct of byte fields. */
export function layoutOf(idl: IdlWithTypes, name: string): Layout {
  const byName = cache.get(idl) ?? new Map<string, Layout>();
  cache.set(idl, byName);
  const hit = byName.get(name);
  if (hit) return hit;
  const def = idl.types?.find((t) => t.name === name);
  if (!def || def.type.kind !== "struct" || !def.type.fields) throw new Error(`No struct ${name} in the IDL`);
  if (def.serialization !== "bytemuck") throw new Error(`${name} is not read in place (serialization ${def.serialization ?? "borsh"})`);
  const at: Record<string, number> = {};
  let size = 0;
  for (const f of def.type.fields) {
    at[f.name] = size;
    size += sizeOf(idl, f.type);
  }
  const layout = { size, at };
  byName.set(name, layout);
  return layout;
}
