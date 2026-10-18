// Fork branch `abyme` only: the daemon routes the openrig plugin reads and writes (loopback only).
//   POST /api/abyme/bind  { rigId, member, agent } -> { nodeId, session }
//   GET  /api/abyme/seats                          -> [{ session, nodeId, rigId, agent }]
//   GET  /api/abyme/flow?rig=<id>&since=<iso>      -> one rig's seats, edges, work and its history
import nodePath from "node:path";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import type { EventBus } from "../domain/event-bus.js";
import type { RigRepository } from "../domain/rig-repository.js";
import type { SessionRegistry } from "../domain/session-registry.js";
import { deriveCanonicalSessionName, deriveSessionName, validateSessionName } from "../domain/session-name.js";
import { QueueWakeRepository } from "../domain/queue-wake-repository.js";
import { nextDueAt } from "../domain/watchdog-due.js";
import { WatchdogJobsRepository } from "../domain/watchdog-jobs-repository.js";
import { ABYME_KIND, type AbymeSeatKind } from "./seat-kind.js";

export interface AbymeRouteDeps {
  db: Database.Database;
  kind: AbymeSeatKind;
  rigRepo: RigRepository;
  sessionRegistry: SessionRegistry;
  eventBus: EventBus;
  /** The delivery guard's lifecycle rebind after a seat changes hands; absent in bare harnesses. */
  rebindLifecycle?: (nodeId: string) => void;
}

const OPEN_STATES = new Set(["pending", "in-progress", "blocked"]);

export function abymeRoutes(deps: AbymeRouteDeps): Hono {
  const { db } = deps;
  const app = new Hono();

  const podOf = (podId: string | null | undefined) => podId
    ? db.prepare("SELECT namespace FROM pods WHERE id = ?").get(podId) as { namespace: string } | undefined
    : undefined;

  app.post("/bind", async (c) => {
    let body: { rigId?: unknown; member?: unknown; agent?: unknown };
    try { body = await c.req.json(); } catch { return c.json({ error: "body must be JSON" }, 400); }
    const { rigId, member, agent } = body;
    if (typeof rigId !== "string" || typeof member !== "string" || typeof agent !== "string" || !rigId || !member || !agent) {
      return c.json({ error: "rigId, member and agent are required strings" }, 400);
    }
    const rig = deps.rigRepo.getRig(rigId);
    if (!rig) return c.json({ error: `rig ${rigId} not found` }, 404);
    const node = rig.nodes.find((n) => n.logicalId === member);
    if (!node) return c.json({ error: `member ${member} not found in rig ${rig.rig.name}` }, 404);
    if (node.binding !== null) return c.json({ error: `member ${member} is already bound` }, 409);
    const holder = db.prepare("SELECT session_name FROM abyme_seats WHERE agent_id = ?").get(agent) as { session_name: string } | undefined;
    if (holder) return c.json({ error: `agent ${agent} already holds ${holder.session_name}` }, 409);

    const pod = podOf(node.podId)?.namespace;
    const session = pod && member.startsWith(`${pod}.`)
      ? deriveCanonicalSessionName(pod, member.slice(pod.length + 1), rig.rig.name)
      : deriveSessionName(rig.rig.name, member);
    if (!validateSessionName(session)) return c.json({ error: `session name ${session} is not a valid OpenRig name` }, 400);

    const generation = deps.sessionRegistry.reserveOccupantGeneration();
    const event = db.transaction(() => {
      const created = deps.sessionRegistry.registerSession(node.id, session, "adopt", generation);
      deps.sessionRegistry.updateStatus(created.id, "running");
      deps.sessionRegistry.updateStartupStatus(created.id, "ready", new Date().toISOString());
      deps.sessionRegistry.updateBinding(node.id, { attachmentType: ABYME_KIND, externalSessionName: session });
      deps.kind.recordSeat({ session, nodeId: node.id, agent });
      return deps.eventBus.persistWithinTransaction({ type: "node.launched", rigId, nodeId: node.id, logicalId: member, sessionName: session });
    })();
    deps.rebindLifecycle?.(node.id);
    deps.eventBus.notifySubscribers(event);
    return c.json({ nodeId: node.id, session });
  });

  app.get("/seats", (c) => {
    const rows = db.prepare(`SELECT s.session_name, s.node_id, n.rig_id, s.agent_id FROM abyme_seats s
      JOIN nodes n ON n.id = s.node_id ORDER BY n.rig_id, s.session_name`).all() as
      Array<{ session_name: string; node_id: string; rig_id: string; agent_id: string }>;
    return c.json(rows.map((r) => ({ session: r.session_name, nodeId: r.node_id, rigId: r.rig_id, agent: r.agent_id })));
  });

  app.get("/flow", (c) => {
    const rigId = c.req.query("rig");
    if (!rigId) return c.json({ error: "rig is required" }, 400);
    const since = c.req.query("since") || null;
    if (since && Number.isNaN(Date.parse(since))) return c.json({ error: "since must be an ISO time" }, 400);
    const rig = deps.rigRepo.getRig(rigId);
    if (!rig) return c.json({ error: `rig ${rigId} not found` }, 404);
    return c.json(readFlow(db, rig, since));
  });

  return app;
}

/** When the wake the holder armed on a parked item is due: a timer or watchdog's next fire, a usage
 *  blocker's timer expiry. Null when nothing is armed and live, and for a plain blocker, which
 *  wakes when its blocker closes rather than at a time. Never the queue's generic backstop. */
function armedWakeAt(wakes: QueueWakeRepository, jobs: WatchdogJobsRepository, qitemId: string): string | null {
  const wake = wakes.getStatus(qitemId);
  if (!wake || wake.phase !== "armed" || !wake.live) return null;
  if (wake.kind === "blocker") return wake.expiresAt ?? null;
  const job = jobs.getById(wake.ref);
  const due = job ? nextDueAt(job) : null;
  return due === null ? wake.expiresAt ?? null : new Date(due).toISOString();
}

type RigWithRelations = NonNullable<ReturnType<RigRepository["getRig"]>>;

/** One rig as the Flow view reads it. Work is an item owned by or sent from one of the rig's
 *  seats; with `since`, closed work and transitions older than it are left out. */
export function readFlow(db: Database.Database, rig: RigWithRelations, since: string | null) {
  const space = (db.prepare("SELECT space_id FROM abyme_rigs WHERE rig_id = ?").get(rig.rig.id) as { space_id: string } | undefined)?.space_id ?? null;
  const pods = db.prepare("SELECT id, namespace, label FROM pods WHERE rig_id = ? ORDER BY namespace").all(rig.rig.id) as
    Array<{ id: string; namespace: string; label: string }>;
  const agentOf = db.prepare("SELECT agent_id FROM abyme_seats WHERE session_name = ?");
  const latestSession = db.prepare("SELECT session_name FROM sessions WHERE node_id = ? ORDER BY id DESC LIMIT 1");

  const seats: Array<{ nodeId: string; member: string; session: string | null; pod: string | null; agent: string | null; removed?: true }> = rig.nodes.map((node) => {
    const session = node.binding?.externalSessionName ?? node.binding?.tmuxSession
      ?? (latestSession.get(node.id) as { session_name: string } | undefined)?.session_name ?? null;
    const agent = session ? (agentOf.get(session) as { agent_id: string } | undefined)?.agent_id ?? null : null;
    return { nodeId: node.id, member: node.logicalId, session, pod: node.podId ?? null, agent };
  });
  // The folder of the spec the rig came up from, which a member's `local:` agent ref is under.
  const source = (db.prepare("SELECT source_ref FROM bootstrap_runs WHERE rig_id = ? AND source_kind = 'rig_spec' ORDER BY created_at DESC, rowid DESC LIMIT 1")
    .get(rig.rig.id) as { source_ref: string } | undefined)?.source_ref;
  const root = source ? nodePath.dirname(source) : null;
  const edges = rig.edges.map((e) => ({ from: e.sourceId, to: e.targetId, kind: e.kind }));
  // Seats an abyme agent held whose node is gone (a change seat after its branch landed): a lane
  // while work in the window names them.
  const standing = new Set(rig.nodes.map((n) => n.id));
  const removed = (db.prepare("SELECT session_name, node_id, member, pod_id FROM abyme_seat_log WHERE rig_id = ?").all(rig.rig.id) as
    Array<{ session_name: string; node_id: string; member: string; pod_id: string | null }>)
    .filter((r) => !standing.has(r.node_id) && !seats.some((s) => s.session === r.session_name));

  const sessions = [...seats.flatMap((s) => (s.session ? [s.session] : [])), ...removed.map((r) => r.session_name)];
  if (sessions.length === 0) return { rig: { id: rig.rig.id, name: rig.rig.name, space, root }, pods, seats, edges, items: [], transitions: [], watches: [] };
  const marks = sessions.map(() => "?").join(", ");

  const itemRows = db.prepare(`SELECT qitem_id, summary, state, destination_session, ts_updated, handed_off_from FROM queue_items
    WHERE destination_session IN (${marks}) OR source_session IN (${marks}) ORDER BY ts_created`).all(...sessions, ...sessions) as
    Array<{ qitem_id: string; summary: string | null; state: string; destination_session: string; ts_updated: string; handed_off_from: string | null }>;
  const wakes = new QueueWakeRepository(db);
  const jobs = new WatchdogJobsRepository(db);
  const items = itemRows
    .filter((r) => !since || OPEN_STATES.has(r.state) || r.ts_updated >= since)
    .map((r) => ({
      id: r.qitem_id, summary: r.summary, state: r.state, owner: r.destination_session,
      wakeAt: r.state === "blocked" ? armedWakeAt(wakes, jobs, r.qitem_id) : null,
      // The item this one continues: a handoff closes an item and opens its successor.
      from: r.handed_off_from,
    }));

  const ids = items.map((i) => i.id);
  const transitions: Array<{ id: number; item: string; ts: string; state: string; actor: string; reason: string | null;
    target: string | null; note: string | null; wake: { phase: string; kind: string; ref: string } | null }> = [];
  for (let at = 0; at < ids.length; at += 400) {
    const chunk = ids.slice(at, at + 400);
    const q = chunk.map(() => "?").join(", ");
    const cols = "transition_id, qitem_id, ts, state, actor_session, closure_reason, closure_target, transition_note";
    const rows = db.prepare(`SELECT t.*, w.phase, w.wake_kind, w.wake_ref FROM (
        SELECT ${cols} FROM queue_transitions WHERE qitem_id IN (${q})
        UNION ALL SELECT ${cols} FROM queue_transitions_archive WHERE qitem_id IN (${q})
      ) t LEFT JOIN queue_transition_wakes w ON w.transition_id = t.transition_id
      ${since ? "WHERE t.ts >= ?" : ""}`).all(...chunk, ...chunk, ...(since ? [since] : [])) as Array<{
        transition_id: number; qitem_id: string; ts: string; state: string; actor_session: string; closure_reason: string | null;
        closure_target: string | null; transition_note: string | null; phase: string | null; wake_kind: string | null; wake_ref: string | null }>;
    for (const r of rows) {
      transitions.push({ id: r.transition_id, item: r.qitem_id, ts: r.ts, state: r.state, actor: r.actor_session,
        reason: r.closure_reason, target: r.closure_target, note: r.transition_note,
        wake: r.phase && r.wake_kind && r.wake_ref ? { phase: r.phase, kind: r.wake_kind, ref: r.wake_ref } : null });
    }
  }
  transitions.sort((a, b) => a.id - b.id);

  const named = new Set([...items.map((i) => i.owner), ...transitions.flatMap((t) => [t.actor, t.target])]);
  for (const r of removed) {
    if (named.has(r.session_name)) seats.push({ nodeId: r.node_id, member: r.member, session: r.session_name, pod: r.pod_id, agent: null, removed: true as const });
  }
  const inRig = new Set(sessions);
  const watches = new WatchdogJobsRepository(db).listActive()
    .filter((job) => inRig.has(job.targetSession))
    .map((job) => {
      const due = nextDueAt(job);
      return { id: job.jobId, policy: job.policy, target: job.targetSession, nextAt: due === null ? null : new Date(due).toISOString() };
    });

  return { rig: { id: rig.rig.id, name: rig.rig.name, space, root }, pods, seats, edges, items, transitions, watches };
}
