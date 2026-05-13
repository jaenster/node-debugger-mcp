import type { Session } from "./session.js";

export class SessionManager {
  private sessions = new Map<string, Session>();
  private nextId = 1;

  mintId(prefix = "s"): string {
    return `${prefix}${this.nextId++}`;
  }

  add(session: Session): void {
    this.sessions.set(session.id, session);
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  /**
   * Resolve the caller's intended session. If only one is active, return it.
   * If multiple, demand explicit id. If none, return undefined.
   */
  resolve(id: string | undefined): Session | undefined {
    if (id) return this.sessions.get(id);
    if (this.sessions.size === 1) {
      const it = this.sessions.values().next();
      return it.done ? undefined : it.value;
    }
    return undefined;
  }

  list(): Session[] {
    return Array.from(this.sessions.values());
  }

  remove(id: string): void {
    this.sessions.delete(id);
  }
}

export const sessions = new SessionManager();
