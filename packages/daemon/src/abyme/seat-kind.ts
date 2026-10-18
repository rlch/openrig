// Fork branch `abyme` only: the `abyme` seat kind. Every host, inbound and activity call on an
// abyme seat is one HTTP call to the openrig plugin on abymed, which turns it into one call on
// abyme's agents API. The plugin's url and token are in `$OPENRIG_HOME/abyme.json`, read per call
// so a plugin restart that rewrites it needs no daemon restart. Which agent holds each seat is
// kept here, in `abyme_seats`; which space each rig is, in `abyme_rigs`.
import fs from "node:fs";
import nodePath from "node:path";
import type Database from "better-sqlite3";
import type { SessionProbe, TmuxResult } from "../adapters/tmux.js";
import type { SeatCreateRequest, SeatCreateResult, SeatKind, SeatRef } from "../domain/seat-kinds.js";
import type { CaptureResult, SendOpts, SendResult } from "../domain/session-transport.js";
import type { AgentActivity } from "../domain/types.js";

export const ABYME_KIND = "abyme";
export const ABYME_ENDPOINT_FILE = "abyme.json";

export interface AbymeEndpoint { url: string; token: string }

/** The plugin's `{ url, token }`, or null when the file is missing or malformed. */
export function readAbymeEndpoint(home: string): AbymeEndpoint | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(nodePath.join(home, ABYME_ENDPOINT_FILE), "utf-8")) as Partial<AbymeEndpoint>;
    return typeof parsed.url === "string" && typeof parsed.token === "string" && parsed.url && parsed.token
      ? { url: parsed.url.replace(/\/+$/, ""), token: parsed.token } : null;
  } catch {
    return null;
  }
}

export class AbymeCallError extends Error {
  constructor(readonly verb: string, message: string, readonly status: number | null) {
    super(message);
  }
}

export interface AbymeSeatKindOptions {
  /** `OPENRIG_HOME`, where `abyme.json` is. */
  home: string;
  fetch?: typeof fetch;
  /** Per call, in ms. `start` gets four times this: an agent takes a while to come up. */
  timeoutMs?: number;
}

/** The seat a session belongs to, and the agent that holds it. */
export interface AbymeSeatRow { session: string; nodeId: string; agent: string }

export class AbymeSeatKind implements SeatKind {
  readonly kind = ABYME_KIND;
  private db: Database.Database | null = null;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly opts: AbymeSeatKindOptions) {
    this.fetchFn = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  /** The daemon's database; createDaemon opens it after the kind is registered. */
  attach(db: Database.Database): void { this.db = db; }

  private get database(): Database.Database {
    if (!this.db) throw new Error("abyme seat kind: no database attached");
    return this.db;
  }

  /** One POST to the plugin's `/api/openrig/seat/<verb>`; throws AbymeCallError on any failure. */
  async call<T>(verb: string, body: unknown): Promise<T> {
    const endpoint = readAbymeEndpoint(this.opts.home);
    if (!endpoint) throw new AbymeCallError(verb, `abyme seat ${verb}: no plugin endpoint in ${nodePath.join(this.opts.home, ABYME_ENDPOINT_FILE)}`, null);
    let res: Response;
    try {
      res = await this.fetchFn(`${endpoint.url}/api/openrig/seat/${verb}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${endpoint.token}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(verb === "start" ? this.timeoutMs * 4 : this.timeoutMs),
      });
    } catch (err) {
      throw new AbymeCallError(verb, `abyme seat ${verb}: ${err instanceof Error ? err.message : String(err)}`, null);
    }
    let parsed: unknown = null;
    try { parsed = await res.json(); } catch { /* answered below */ }
    if (!res.ok) {
      const error = (parsed as { error?: unknown } | null)?.error;
      throw new AbymeCallError(verb, `abyme seat ${verb}: ${typeof error === "string" ? error : `HTTP ${res.status}`}`, res.status);
    }
    return parsed as T;
  }

  seatForSession(session: string): AbymeSeatRow | null {
    const row = this.database.prepare("SELECT session_name, node_id, agent_id FROM abyme_seats WHERE session_name = ?")
      .get(session) as { session_name: string; node_id: string; agent_id: string } | undefined;
    return row ? { session: row.session_name, nodeId: row.node_id, agent: row.agent_id } : null;
  }

  /** Record that `agent` holds the seat; called by `create` and by the bind route. */
  recordSeat(seat: AbymeSeatRow, rig?: { rigId: string; space: string }): void {
    const db = this.database;
    db.transaction(() => {
      db.prepare("INSERT OR REPLACE INTO abyme_seats (session_name, node_id, agent_id) VALUES (?, ?, ?)").run(seat.session, seat.nodeId, seat.agent);
      if (rig?.space) db.prepare("INSERT OR REPLACE INTO abyme_rigs (rig_id, space_id) VALUES (?, ?)").run(rig.rigId, rig.space);
    })();
  }

  private forgetSeat(session: string): void {
    this.database.prepare("DELETE FROM abyme_seats WHERE session_name = ?").run(session);
  }

  readonly host = {
    create: async (req: SeatCreateRequest): Promise<SeatCreateResult> => {
      const node = this.database.prepare(`SELECT n.rig_id, n.logical_id, p.namespace FROM nodes n
        LEFT JOIN pods p ON p.id = n.pod_id WHERE n.id = ?`).get(req.nodeId) as
        { rig_id: string; logical_id: string; namespace: string | null } | undefined;
      if (!node) return { ok: false, code: "node_not_found", message: `abyme seat: node ${req.nodeId} not found` };
      const pod = node.namespace || null;
      const member = pod && node.logical_id.startsWith(`${pod}.`) ? node.logical_id.slice(pod.length + 1) : node.logical_id;
      try {
        const started = await this.call<{ agent?: unknown; space?: unknown }>("start", {
          rig: node.rig_id, rigName: req.rigName, pod, member, session: req.sessionName,
          ...(req.cwd ? { cwd: req.cwd } : {}),
          ...(req.env.ABYME_PRESET ? { preset: req.env.ABYME_PRESET } : {}),
        });
        if (typeof started?.agent !== "string" || !started.agent) {
          return { ok: false, code: "abyme_start_failed", message: "abyme seat start: the plugin answered no agent" };
        }
        this.recordSeat({ session: req.sessionName, nodeId: req.nodeId, agent: started.agent },
          typeof started.space === "string" ? { rigId: node.rig_id, space: started.space } : undefined);
        return { ok: true, binding: {}, warnings: [] };
      } catch (err) {
        return { ok: false, code: "abyme_start_failed", message: (err as Error).message };
      }
    },

    // The agent started in `create`; there is no harness for OpenRig to launch.
    launch: async () => ({ ok: true as const }),

    checkReady: async (binding: { externalSessionName?: string | null }) => {
      const probe = await this.host.probe({ sessionName: binding.externalSessionName ?? "" } as SeatRef);
      if (probe.state === "present") return { ready: true };
      return { ready: false, reason: probe.state === "absent" ? "the abyme agent is gone" : probe.cause };
    },

    probe: async (ref: SeatRef): Promise<SessionProbe> => {
      const seat = this.seatForSession(ref.sessionName);
      if (!seat) return { state: "absent" };
      try {
        const answer = await this.call<{ present?: unknown }>("probe", { agent: seat.agent });
        return answer?.present === true ? { state: "present" } : { state: "absent" };
      } catch (err) {
        return { state: "transport_unavailable", cause: (err as Error).message };
      }
    },

    stop: async (ref: SeatRef): Promise<TmuxResult> => {
      const seat = this.seatForSession(ref.sessionName);
      if (!seat) return { ok: false, code: "session_not_found", message: `No abyme agent holds ${ref.sessionName}` };
      try {
        await this.call("stop", { agent: seat.agent });
      } catch (err) {
        return { ok: false, code: "abyme_stop_failed", message: (err as Error).message };
      }
      this.forgetSeat(ref.sessionName);
      return { ok: true };
    },
  };

  readonly inbound = {
    deliver: async (ref: SeatRef, text: string, opts: SendOpts): Promise<SendResult> => {
      const seat = this.seatForSession(ref.sessionName);
      if (!seat) return { ok: false, sessionName: ref.sessionName, reason: "session_missing", error: `No abyme agent holds ${ref.sessionName}` };
      // A plain send names its sender only as the actor; a seat's actor is the seat.
      const fromSession = opts.origin ? opts.origin.fromSession : opts.actorSession ?? undefined;
      const from = fromSession ? this.seatForSession(fromSession)?.agent : undefined;
      try {
        await this.call("deliver", { agent: seat.agent, text, kind: opts.origin?.kind ?? "message", ...(from ? { from } : {}) });
        return { ok: true, sessionName: ref.sessionName, verified: true, outcome: "delivered" };
      } catch (err) {
        return { ok: false, sessionName: ref.sessionName, reason: "send_failed", outcome: "failed", error: (err as Error).message };
      }
    },

    capture: async (ref: SeatRef, lines: number): Promise<CaptureResult> => {
      const seat = this.seatForSession(ref.sessionName);
      if (!seat) return { ok: false, sessionName: ref.sessionName, reason: "session_missing", error: `No abyme agent holds ${ref.sessionName}` };
      try {
        const answer = await this.call<{ text?: unknown }>("capture", { agent: seat.agent });
        const content = typeof answer?.text === "string" ? answer.text : "";
        return { ok: true, sessionName: ref.sessionName, content, lines };
      } catch (err) {
        return { ok: false, sessionName: ref.sessionName, reason: "capture_failed", error: (err as Error).message };
      }
    },
  };

  readonly activity = {
    /** What abyme last posted to `/api/activity/hooks` for this seat, however old: abyme posts on
     *  each change, so the last post is the agent's state until the next. */
    probe: async (ref: SeatRef, now: Date): Promise<AgentActivity> => {
      const row = ref.nodeId ? this.database.prepare(
        "SELECT payload FROM events WHERE node_id = ? AND type = 'agent.activity' ORDER BY seq DESC LIMIT 1",
      ).get(ref.nodeId) as { payload: string } | undefined : undefined;
      let posted: { sessionName?: string; activity?: AgentActivity } | null = null;
      try { posted = row ? JSON.parse(row.payload) : null; } catch { /* unknown below */ }
      const activity = posted?.sessionName === ref.sessionName ? posted.activity : undefined;
      if (!activity) {
        return { state: "unknown", reason: "abyme_no_activity", evidenceSource: "runtime_hook", sampledAt: now.toISOString(), evidence: null };
      }
      return { ...activity, stale: false, sampledAt: now.toISOString() };
    },
  };
}
