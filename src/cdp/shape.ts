// Shape CDP RemoteObject / PropertyDescriptor values into LLM-friendly
// previews. The goal is one terse line per value, with a localObjectId
// when the consumer needs to drill in.

import type { ObjectRegistry } from "./object-registry.js";

export interface RemoteObjectLike {
  type: string;
  subtype?: string;
  className?: string;
  value?: unknown;
  description?: string;
  objectId?: string;
  unserializableValue?: string;
  preview?: { description?: string; properties?: Array<{ name: string; type: string; value?: string }> };
}

export interface ShapedValue {
  type: string;
  subtype?: string;
  preview: string;
  className?: string;
  localObjectId?: string;
}

export function shapeRemoteObject(
  obj: RemoteObjectLike | undefined,
  registry: ObjectRegistry,
): ShapedValue {
  if (!obj) return { type: "undefined", preview: "undefined" };
  const out: ShapedValue = {
    type: obj.type,
    preview: renderPreview(obj),
  };
  if (obj.subtype) out.subtype = obj.subtype;
  if (obj.className) out.className = obj.className;
  if (obj.objectId) out.localObjectId = registry.mint(obj.objectId);
  return out;
}

function renderPreview(obj: RemoteObjectLike): string {
  if (obj.unserializableValue) return obj.unserializableValue;
  if (obj.type === "string") return JSON.stringify(obj.value);
  if (obj.type === "number" || obj.type === "boolean") return String(obj.value);
  if (obj.type === "undefined") return "undefined";
  if (obj.type === "function") return obj.description ?? "[function]";
  if (obj.type === "symbol") return obj.description ?? "[symbol]";
  if (obj.type === "bigint") return (obj.description ?? obj.unserializableValue) ?? "0n";
  if (obj.subtype === "null") return "null";
  if (obj.subtype === "array") {
    if (obj.preview?.properties) {
      const items = obj.preview.properties.map((p) => p.value ?? `[${p.type}]`);
      return `[${items.join(", ")}]`;
    }
    return obj.description ?? "Array";
  }
  if (obj.subtype === "date") return obj.description ?? "Date";
  if (obj.subtype === "regexp") return obj.description ?? "RegExp";
  if (obj.subtype === "error") return obj.description ?? "Error";
  if (obj.subtype === "map" || obj.subtype === "set") return obj.description ?? obj.subtype;
  // Generic object — use preview properties if present, fall back to className.
  if (obj.preview?.properties && obj.preview.properties.length > 0) {
    const parts = obj.preview.properties.map(
      (p) => `${p.name}: ${p.value ?? `[${p.type}]`}`,
    );
    const inside = parts.slice(0, 5).join(", ");
    const more = parts.length > 5 ? `, ... +${parts.length - 5}` : "";
    return `{ ${inside}${more} }`;
  }
  return obj.description ?? obj.className ?? "Object";
}

export interface ScopeEntry {
  name: string;
  value: ShapedValue;
}
