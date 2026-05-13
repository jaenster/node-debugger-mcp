// V8 RemoteObject ids are valid only until execution resumes. We mint
// short stable local ids (`obj#42`) and invalidate the whole table on
// every Debugger.resumed event. Tools accept the local id and we look up
// the real CDP objectId at call time.

export interface RegistryEntry {
  cdpObjectId: string;
}

export class ObjectRegistry {
  private next = 1;
  private entries = new Map<string, RegistryEntry>();

  mint(cdpObjectId: string): string {
    const id = `obj#${this.next++}`;
    this.entries.set(id, { cdpObjectId });
    return id;
  }

  get(id: string): RegistryEntry | undefined {
    return this.entries.get(id);
  }

  invalidate(): void {
    this.entries.clear();
    // Keep `next` ticking forward across resumes so ids don't collide if a
    // stale id sneaks through a tool call. Stale lookups still miss.
  }
}
