// Fork branch `abyme`: the abyme seat kind inside a real createDaemon, against a stub of the
// openrig plugin's routes. Each seat call must be one HTTP call there, and tmux must never be asked.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type Database from "better-sqlite3";
import { createDaemon } from "../src/startup.js";
import type { AppDeps } from "../src/server.js";
import type { CmuxTransportFactory } from "../src/terminal/cmux-transport.js";
import type { ArgvExecFn, ExecFn } from "../src/adapters/tmux.js";
import { AbymeSeatKind, ABYME_ENDPOINT_FILE } from "../src/abyme/seat-kind.js";
import { abymeRoutes } from "../src/abyme/routes.js";
import { PodRepository } from "../src/domain/pod-repository.js";
import type { Hono } from "hono";

const TOKEN = "stub-token";
interface Call { verb: string; body: Record<string, unknown>; auth: string | undefined }

/** The plugin's five routes; `agents` is who is running, `answers` overrides a verb's reply. */
function stubPlugin() {
  const calls: Call[] = [];
  const agents = new Set<string>();
  const answers: Record<string, { status: number; body: unknown }> = {};
  let next = 0;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const verb = (req.url ?? "").replace("/api/openrig/seat/", "");
      const body = raw ? JSON.parse(raw) as Record<string, unknown> : {};
      calls.push({ verb, body, auth: req.headers.authorization });
      const send = (status: number, payload: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(payload)); };
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: "bad token" });
      if (answers[verb]) return send(answers[verb]!.status, answers[verb]!.body);
      const agent = body.agent as string;
      switch (verb) {
        case "start": { const id = `acp:a${++next}`; agents.add(id); return send(200, { agent: id, space: "group:factory" }); }
        case "stop": { const gone = agents.delete(agent); return send(200, { gone }); }
        case "probe": return send(200, { present: agents.has(agent), status: agents.has(agent) ? "idle" : null });
        case "deliver": return agents.has(agent) ? send(200, { ok: true }) : send(404, { error: "no such agent" });
        case "capture": return send(200, { text: `last reply of ${agent}` });
        default: return send(404, { error: "no route" });
      }
    });
  });
  return { server, calls, agents, answers };
}

let db: Database.Database;
let deps: AppDeps;
let app: Hono;
let scratch: string;
let home: string;
let plugin: ReturnType<typeof stubPlugin>;
const savedEnv: Record<string, string | undefined> = {};
const tmuxCommands: string[] = [];

beforeAll(async () => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "abyme-seat-kind-"));
  home = path.join(scratch, "home");
  fs.mkdirSync(home, { recursive: true });
  plugin = stubPlugin();
  await new Promise<void>((resolve) => plugin.server.listen(0, "127.0.0.1", resolve));
  const { port } = plugin.server.address() as AddressInfo;
  fs.writeFileSync(path.join(home, ABYME_ENDPOINT_FILE), JSON.stringify({ url: `http://127.0.0.1:${port}`, token: TOKEN }));

  for (const k of ["OPENRIG_HOME", "OPENRIG_DB", "OPENRIG_URL", "OPENRIG_PORT", "OPENRIG_NO_KERNEL", "OPENRIG_ACTIVITY_HOOK_TOKEN"]) savedEnv[k] = process.env[k];
  process.env.OPENRIG_HOME = home;
  process.env.OPENRIG_DB = path.join(scratch, "daemon.sqlite");
  delete process.env.OPENRIG_URL;
  delete process.env.OPENRIG_PORT;
  process.env.OPENRIG_NO_KERNEL = "1";
  process.env.OPENRIG_ACTIVITY_HOOK_TOKEN = TOKEN;
  const cmuxFactory: CmuxTransportFactory = async () => { throw Object.assign(new Error("no socket"), { code: "ENOENT" }); };
  const tmuxExec: ExecFn = async (cmd) => { tmuxCommands.push(cmd); return ""; };
  const argvExec: ArgvExecFn = async (argv) => { tmuxCommands.push(argv.join(" ")); return ""; };
  const kind = new AbymeSeatKind({ home, timeoutMs: 5_000 });
  const result = await createDaemon({
    cmuxFactory, tmuxExec, argvExec, dbPath: process.env.OPENRIG_DB!,
    seatKinds: [kind], defaultSeatKind: kind.kind, onDatabase: (d) => kind.attach(d),
    routes: (d) => ({ "/api/abyme": abymeRoutes({ db: d.rigRepo.db, kind, rigRepo: d.rigRepo, sessionRegistry: d.sessionRegistry, eventBus: d.eventBus }) }),
  });
  db = result.db;
  deps = result.deps;
  app = result.app;
}, 60000);

afterAll(async () => {
  db?.close();
  await new Promise<void>((resolve) => plugin.server.close(() => resolve()));
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(scratch, { recursive: true, force: true });
});

beforeEach(() => { plugin.calls.length = 0; tmuxCommands.length = 0; });

let rigCount = 0;
/** A rig `factory<n>` with pod `dev` holding `dev.build` and `dev.review`, review reporting to build. */
function makeRig() {
  const rig = deps.rigRepo.createRig(`factory${++rigCount}`);
  const pod = new PodRepository(db).createPod(rig.id, "dev", "Dev");
  const build = deps.rigRepo.addNode(rig.id, "dev.build", { role: "worker", runtime: "claude-code", podId: pod.id });
  const review = deps.rigRepo.addNode(rig.id, "dev.review", { role: "worker", runtime: "claude-code", podId: pod.id });
  deps.rigRepo.addEdge(rig.id, build.id, review.id, "delegates_to");
  return { rig, pod, build, review };
}

async function launch(rigId: string, logicalId: string, rigName: string) {
  const [pod, member] = logicalId.split(".") as [string, string];
  const launched = await deps.nodeLauncher.launchNode(rigId, logicalId, { sessionName: `${pod}-${member}@${rigName}` });
  if (!launched.ok) throw new Error(launched.message);
  return launched;
}

const agentOf = (session: string) =>
  (db.prepare("SELECT agent_id FROM abyme_seats WHERE session_name = ?").get(session) as { agent_id: string } | undefined)?.agent_id;

describe("the abyme seat kind", () => {
  it("launches a seat by starting an agent through the plugin, with no tmux", async () => {
    const { rig, pod, build } = makeRig();
    const launched = await launch(rig.id, "dev.build", rig.name);

    expect(plugin.calls).toEqual([{ verb: "start", auth: `Bearer ${TOKEN}`,
      body: { rig: rig.id, rigName: rig.name, pod: "dev", member: "build", session: launched.sessionName } }]);
    expect(deps.sessionRegistry.getBindingForNode(build.id)).toMatchObject({ attachmentType: "abyme", externalSessionName: launched.sessionName });
    expect(agentOf(launched.sessionName)).toMatch(/^acp:a\d+$/);
    expect(db.prepare("SELECT space_id FROM abyme_rigs WHERE rig_id = ?").get(rig.id)).toEqual({ space_id: "group:factory" });
    expect(tmuxCommands).toEqual([]);
    expect(pod.namespace).toBe("dev");
  });

  it("delivers a plain send as a message from the sending seat's agent", async () => {
    const { rig } = makeRig();
    const build = await launch(rig.id, "dev.build", rig.name);
    const review = await launch(rig.id, "dev.review", rig.name);
    plugin.calls.length = 0;

    const sent = await deps.sessionTransport!.send(review.sessionName, "look at this", { actorSession: build.sessionName });
    expect(sent).toMatchObject({ ok: true, verified: true });
    expect(plugin.calls).toEqual([{ verb: "deliver", auth: `Bearer ${TOKEN}`,
      body: { agent: agentOf(review.sessionName), text: "look at this", kind: "message", from: agentOf(build.sessionName) } }]);

    plugin.calls.length = 0;
    await deps.sessionTransport!.send(review.sessionName, "from no seat", { actorSession: "watchdog@system" });
    expect(plugin.calls[0]!.body).toEqual({ agent: agentOf(review.sessionName), text: "from no seat", kind: "message" });
    expect(tmuxCommands).toEqual([]);
  });

  it("nudges a created item as a message and a handed-off one as a handoff, from the sender", async () => {
    const { rig } = makeRig();
    const build = await launch(rig.id, "dev.build", rig.name);
    const review = await launch(rig.id, "dev.review", rig.name);
    plugin.calls.length = 0;

    const item = await deps.queueRepo!.create({ sourceSession: build.sessionName, destinationSession: review.sessionName, body: "review the build" });
    await expect.poll(() => plugin.calls.filter((c) => c.verb === "deliver").length).toBe(1);
    expect(plugin.calls[0]!.body).toMatchObject({ agent: agentOf(review.sessionName), kind: "message", from: agentOf(build.sessionName) });
    expect(plugin.calls[0]!.body.text).toContain(item.qitemId);

    plugin.calls.length = 0;
    await deps.queueRepo!.handoff({ qitemId: item.qitemId, fromSession: review.sessionName, toSession: build.sessionName, body: "fix what I found" });
    await expect.poll(() => plugin.calls.filter((c) => c.verb === "deliver").length).toBe(1);
    expect(plugin.calls[0]!.body).toMatchObject({ agent: agentOf(build.sessionName), kind: "handoff", from: agentOf(review.sessionName) });
    expect(tmuxCommands).toEqual([]);
  });

  it("starts a change's seat on its branch, off its base", async () => {
    const { rig } = makeRig();
    const launched = await deps.nodeLauncher.launchNode(rig.id, "dev.build", { sessionName: `dev-build@${rig.name}`, env: { ABYME_BRANCH: "openrig-give-work" } });
    if (!launched.ok) throw new Error(launched.message);
    expect(plugin.calls.find((c) => c.verb === "start")!.body).toMatchObject({ member: "build", branch: "openrig-give-work", base: "main" });
    plugin.calls.length = 0;
    const review = await deps.nodeLauncher.launchNode(rig.id, "dev.review", { sessionName: `dev-review@${rig.name}`, env: { ABYME_BRANCH: "x", ABYME_BASE: "release" } });
    if (!review.ok) throw new Error(review.message);
    expect(plugin.calls.find((c) => c.verb === "start")!.body).toMatchObject({ branch: "x", base: "release" });

    // A member added for a change names its branch in its own env.
    plugin.calls.length = 0;
    const pod = new PodRepository(db).getPodByNamespace(rig.id, "dev")!;
    deps.rigRepo.addNode(rig.id, "dev.openrig-seats", { role: "worker", runtime: "claude-code", podId: pod.id, env: { ABYME_BRANCH: "openrig-seats" } });
    await launch(rig.id, "dev.openrig-seats", rig.name);
    expect(plugin.calls.find((c) => c.verb === "start")!.body).toMatchObject({ member: "openrig-seats", branch: "openrig-seats", base: "main" });
  });

  it("passes an abyme agent that holds no seat as the sender, and the operator as none", async () => {
    const { rig } = makeRig();
    const build = await launch(rig.id, "dev.build", rig.name);
    plugin.calls.length = 0;

    await deps.queueRepo!.create({ sourceSession: "agent:acp:k3", destinationSession: build.sessionName, body: "write the README" });
    await expect.poll(() => plugin.calls.filter((c) => c.verb === "deliver").length).toBe(1);
    expect(plugin.calls[0]!.body).toMatchObject({ agent: agentOf(build.sessionName), kind: "message", from: "acp:k3" });

    plugin.calls.length = 0;
    await deps.queueRepo!.create({ sourceSession: "operator", destinationSession: build.sessionName, body: "and the docs" });
    await expect.poll(() => plugin.calls.filter((c) => c.verb === "deliver").length).toBe(1);
    expect(plugin.calls[0]!.body.from).toBeUndefined();
  });

  it("delivers a watchdog's fire as a watch, and a parked item's timer as a wake", async () => {
    const { rig } = makeRig();
    const build = await launch(rig.id, "dev.build", rig.name);
    plugin.calls.length = 0;
    const jobs = deps.watchdogJobsRepo!;
    const job = jobs.register({
      policy: "periodic-reminder", targetSession: build.sessionName, intervalSeconds: 60, registeredBySession: "operator@kernel",
      specYaml: ["policy: periodic-reminder", "target:", `  session: ${JSON.stringify(build.sessionName)}`, 'message: "check the build"', ""].join("\n"),
    });
    jobs.recordEvaluation(job.jobId, "2000-01-01T00:00:00.000Z", false);
    await deps.watchdogScheduler!.runTickNow();
    await expect.poll(() => plugin.calls.filter((c) => c.verb === "deliver").length).toBe(1);
    expect(plugin.calls[0]!.body).toMatchObject({ agent: agentOf(build.sessionName), kind: "watch" });
    expect(plugin.calls[0]!.body).not.toHaveProperty("from");

    plugin.calls.length = 0;
    const item = await deps.queueRepo!.create({ sourceSession: build.sessionName, destinationSession: build.sessionName, body: "come back to this", nudge: false });
    await deps.queueRepo!.update({ qitemId: item.qitemId, actorSession: build.sessionName, state: "blocked", wakeAfterSeconds: 60 });
    const timer = db.prepare("SELECT wake_ref FROM queue_transition_wakes WHERE qitem_id = ? AND wake_kind = 'timer'").get(item.qitemId) as { wake_ref: string };
    jobs.recordEvaluation(timer.wake_ref, "2000-01-01T00:00:00.000Z", false);
    await deps.watchdogScheduler!.runTickNow();
    await expect.poll(() => plugin.calls.filter((c) => c.verb === "deliver").length).toBe(1);
    expect(plugin.calls[0]!.body).toMatchObject({ agent: agentOf(build.sessionName), kind: "wake" });
  });

  it("captures the agent's last reply, probes it and stops it", async () => {
    const { rig } = makeRig();
    const build = await launch(rig.id, "dev.build", rig.name);
    const agent = agentOf(build.sessionName)!;
    plugin.calls.length = 0;

    expect(await deps.sessionTransport!.capture(build.sessionName)).toMatchObject({ ok: true, content: `last reply of ${agent}` });
    const ref = { nodeId: null, sessionName: build.sessionName, runtime: null, kind: "abyme", pane: null, occupant: null };
    const kind = deps.seatKinds!.custom("abyme")!;
    expect(await kind.host.probe(ref)).toEqual({ state: "present" });
    expect(await kind.host.stop(ref)).toEqual({ ok: true });
    expect(plugin.agents.has(agent)).toBe(false);
    expect(agentOf(build.sessionName)).toBeUndefined();
    expect(await kind.host.probe(ref)).toEqual({ state: "absent" });
    expect(await kind.host.stop(ref)).toMatchObject({ ok: false, code: "session_not_found" });
    expect(plugin.calls.map((c) => c.verb)).toEqual(["capture", "probe", "stop"]);
    expect(tmuxCommands).toEqual([]);
  });

  it("holds no seat of a rig brought up again under a deleted one's name", async () => {
    const first = deps.rigRepo.createRig("pr-1");
    const firstPod = new PodRepository(db).createPod(first.id, "dev", "Dev");
    deps.rigRepo.addNode(first.id, "dev.build", { role: "worker", runtime: "claude-code", podId: firstPod.id });
    const old = await launch(first.id, "dev.build", "pr-1");
    const oldAgent = agentOf(old.sessionName)!;
    deps.rigRepo.deleteRig(first.id);

    const again = deps.rigRepo.createRig("pr-1");
    const pod = new PodRepository(db).createPod(again.id, "dev", "Dev");
    const build = deps.rigRepo.addNode(again.id, "dev.build", { role: "worker", runtime: "claude-code", podId: pod.id });
    const kind = deps.seatKinds!.custom("abyme")! as AbymeSeatKind;
    expect(kind.seatForSession(old.sessionName)).toBeNull();
    type Seats = { seats: Array<{ session: string; agent: string | null }> };
    const flow = await (await app.request(`/api/abyme/flow?rig=${again.id}`)).json() as Seats;
    expect(flow.seats).toEqual([expect.objectContaining({ nodeId: build.id, session: old.sessionName, agent: null })]);

    // Its first work starts an agent of its own, never the old rig's.
    plugin.calls.length = 0;
    const launched = await launch(again.id, "dev.build", "pr-1");
    expect(plugin.calls.map((c) => c.verb)).toEqual(["start"]);
    expect(kind.seatForSession(launched.sessionName)).toMatchObject({ nodeId: build.id });
    expect(kind.seatForSession(launched.sessionName)!.agent).not.toBe(oldAgent);
  });

  it("answers activity from what abyme last posted", async () => {
    const { rig, build: node } = makeRig();
    const build = await launch(rig.id, "dev.build", rig.name);
    const kind = deps.seatKinds!.custom("abyme")!;
    const ref = { nodeId: node.id, sessionName: build.sessionName, runtime: "claude-code", kind: "abyme", pane: null, occupant: null };
    expect((await kind.activity.probe(ref, new Date())).state).toBe("unknown");

    const post = (hookEvent: string, subtype?: string) => app.request("/api/activity/hooks", {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ sessionName: build.sessionName, hookEvent, ...(subtype ? { subtype } : {}) }),
    });
    expect((await post("active")).status).toBeLessThan(300);
    expect((await kind.activity.probe(ref, new Date())).state).toBe("running");
    // OpenRig's own store credits it to the seat's live occupant, not "generation unverifiable".
    const stored = deps.agentActivityStore!.getLatestForNode({ sessionName: build.sessionName });
    expect(stored?.state, JSON.stringify(stored)).toBe("running");
    expect(stored?.generation).toBe(deps.sessionRegistry.currentOccupantTenure(node.id)?.generationUuid);
    await post("Notification", "permission_prompt");
    expect((await kind.activity.probe(ref, new Date())).state).toBe("needs_input");
    await post("idle");
    // However long ago: abyme posts only on change.
    expect((await kind.activity.probe(ref, new Date(Date.now() + 86_400_000))).state).toBe("idle");
    expect(plugin.calls.map((c) => c.verb)).toEqual(["start"]);
  });

  it("fails a delivery the plugin refuses, and one with no endpoint file", async () => {
    const { rig } = makeRig();
    const build = await launch(rig.id, "dev.build", rig.name);
    plugin.answers.deliver = { status: 409, body: { error: "agent is closed" } };
    try {
      expect(await deps.sessionTransport!.send(build.sessionName, "hi")).toMatchObject({ ok: false, error: "abyme seat deliver: agent is closed" });
    } finally { delete plugin.answers.deliver; }

    const file = path.join(home, ABYME_ENDPOINT_FILE);
    const saved = fs.readFileSync(file, "utf-8");
    fs.rmSync(file);
    try {
      const sent = await deps.sessionTransport!.send(build.sessionName, "hi");
      expect(sent.ok).toBe(false);
      expect(sent.error).toContain("no plugin endpoint");
    } finally { fs.writeFileSync(file, saved); }
  });
});

describe("the abyme routes", () => {
  it("binds a running agent to an unbound member without starting one", async () => {
    const { rig, review } = makeRig();
    const res = await app.request("/api/abyme/bind", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ rigId: rig.id, member: "dev.review", agent: "acp:running" }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ nodeId: review.id, session: `dev-review@${rig.name}` });
    expect(plugin.calls).toEqual([]);
    expect(deps.sessionRegistry.getBindingForNode(review.id)).toMatchObject({ attachmentType: "abyme", externalSessionName: `dev-review@${rig.name}` });
    // No native resume token to go back to: a restore relaunches it fresh without asking.
    expect(db.prepare("SELECT restore_policy FROM sessions WHERE session_name = ?").get(`dev-review@${rig.name}`)).toEqual({ restore_policy: "relaunch_fresh" });

    const seats = await (await app.request("/api/abyme/seats")).json() as unknown[];
    expect(seats).toContainEqual({ session: `dev-review@${rig.name}`, nodeId: review.id, rigId: rig.id, agent: "acp:running" });

    const again = await app.request("/api/abyme/bind", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ rigId: rig.id, member: "dev.review", agent: "acp:other" }) });
    expect(again.status).toBe(409);
    const missing = await app.request("/api/abyme/bind", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ rigId: rig.id, member: "dev.nobody", agent: "acp:other" }) });
    expect(missing.status).toBe(404);
    expect(tmuxCommands).toEqual([]);
  });

  it("keeps a removed seat in a rig's flow while work in its window names it", async () => {
    const { rig, pod, review: reviewNode } = makeRig();
    const build = await launch(rig.id, "dev.build", rig.name);
    const review = await launch(rig.id, "dev.review", rig.name);
    const item = await deps.queueRepo!.create({ sourceSession: build.sessionName, destinationSession: review.sessionName, body: "review it", summary: "review" });
    await deps.queueRepo!.handoff({ qitemId: item.qitemId, fromSession: review.sessionName, toSession: build.sessionName, body: "fix it" });

    const removed = await app.request(`/api/rigs/${rig.id}/nodes/dev.review`, { method: "DELETE" });
    expect(removed.status).toBe(200);
    type Seats = { seats: Array<{ session: string; agent: string | null; removed?: boolean }>; items: Array<{ owner: string }> };
    const flow = await (await app.request(`/api/abyme/flow?rig=${rig.id}`)).json() as Seats;
    expect(flow.seats.find((s) => s.session === review.sessionName)).toEqual({ nodeId: reviewNode.id, member: "dev.review", session: review.sessionName, pod: pod.id, agent: null, removed: true });
    expect(flow.items.map((i) => i.owner)).toEqual([review.sessionName, build.sessionName]);

    // Past its window, nothing names it: it is gone.
    const later = await (await app.request(`/api/abyme/flow?rig=${rig.id}&since=${new Date(Date.now() + 60_000).toISOString()}`)).json() as Seats;
    expect(later.seats.map((s) => s.session)).toEqual([build.sessionName]);
  });

  it("reads a rigspec as JSON, and answers why one does not read", async () => {
    const yaml = "version: \"0.2\"\nname: demo\npods:\n  - id: dev\n    label: Dev\n    members:\n      - id: build\n        agent_ref: \"local:agents/worker\"\n        runtime: claude-code\n    edges: []\nedges: []\n";
    const ok = await app.request("/api/abyme/spec", { method: "POST", body: yaml });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ spec: { name: "demo", pods: [{ id: "dev", members: [{ id: "build", agent_ref: "local:agents/worker", runtime: "claude-code" }] }] } });
    const bad = await app.request("/api/abyme/spec", { method: "POST", body: "name: [unclosed" });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBeTruthy();
  });

  it("reads a rig's flow: pods, seats, edges, work, transitions and watches", async () => {
    const { rig, pod, build: buildNode, review: reviewNode } = makeRig();
    const build = await launch(rig.id, "dev.build", rig.name);
    const review = await launch(rig.id, "dev.review", rig.name);
    const item = await deps.queueRepo!.create({ sourceSession: build.sessionName, destinationSession: review.sessionName, body: "review it", summary: "review the build" });
    await deps.queueRepo!.handoff({ qitemId: item.qitemId, fromSession: review.sessionName, toSession: build.sessionName, body: "fix it" });

    const res = await app.request(`/api/abyme/flow?rig=${rig.id}`);
    expect(res.status).toBe(200);
    const flow = await res.json() as {
      rig: unknown; pods: unknown[]; seats: unknown[]; edges: unknown[];
      items: Array<{ id: string; state: string; owner: string; wakeAt: string | null; from: string | null }>;
      transitions: Array<{ item: string; state: string; actor: string; note: string | null; wake: unknown }>; watches: unknown[];
    };
    expect(flow.rig).toEqual({ id: rig.id, name: rig.name, space: "group:factory", root: null });
    expect(flow.pods).toEqual([{ id: pod.id, namespace: "dev", label: "Dev" }]);
    expect(flow.seats).toEqual([
      { nodeId: buildNode.id, member: "dev.build", session: build.sessionName, pod: pod.id, agent: agentOf(build.sessionName) },
      { nodeId: reviewNode.id, member: "dev.review", session: review.sessionName, pod: pod.id, agent: agentOf(review.sessionName) },
    ]);
    expect(flow.edges).toEqual([{ from: buildNode.id, to: reviewNode.id, kind: "delegates_to" }]);
    expect(flow.items.map((i) => [i.id === item.qitemId, i.state, i.owner])).toEqual([[true, "handed-off", review.sessionName], [false, "pending", build.sessionName]]);
    expect(flow.items.map((i) => i.from)).toEqual([null, item.qitemId]);
    // A fresh pending item has no armed wake, whatever the queue's backstop says.
    expect(flow.items.map((i) => i.wakeAt)).toEqual([null, null]);
    expect(flow.transitions.length).toBeGreaterThanOrEqual(3);
    expect(flow.transitions.every((t) => "note" in t && "wake" in t)).toBe(true);
    expect(flow.transitions.find((t) => t.item === item.qitemId && t.state === "handed-off")?.actor).toBe(review.sessionName);
    expect(flow.watches).toEqual([]);

    // Parked with a timer, its wake is the timer's next fire.
    const parked = flow.items[1]!.id;
    await deps.queueRepo!.update({ qitemId: parked, actorSession: build.sessionName, state: "blocked", wakeAfterSeconds: 600 });
    const armed = await (await app.request(`/api/abyme/flow?rig=${rig.id}`)).json() as typeof flow;
    const wakeAt = armed.items.find((i) => i.id === parked)!.wakeAt;
    expect(wakeAt).not.toBeNull();
    expect(Date.parse(wakeAt!) - Date.now()).toBeGreaterThan(590_000);
    expect(Date.parse(wakeAt!) - Date.now()).toBeLessThanOrEqual(600_000);

    const later = await (await app.request(`/api/abyme/flow?rig=${rig.id}&since=2999-01-01T00:00:00.000Z`)).json() as typeof flow;
    expect(later.items.map((i) => i.state)).toEqual(["blocked"]);
    expect(later.transitions).toEqual([]);
    expect((await app.request("/api/abyme/flow")).status).toBe(400);
    expect((await app.request("/api/abyme/flow?rig=nope")).status).toBe(404);
  });
});
