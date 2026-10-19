#!/usr/bin/env node
// Rewrites an abyme document for one OpenRig rig from the daemon's API.
// Layout (pods, seats, edges) and queue counts are snapshotted each run; each seat's activity is a
// live agents.agent Query, so it follows abyme between runs.
// Usage: node rig-page.mjs [--watch] [--rig abyme] [--daemon http://127.0.0.1:7439] [--out <file.md>]
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";

const run = promisify(execFile);
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const RIG = arg("rig", "abyme");
const DAEMON = arg("daemon", "http://127.0.0.1:7439");
const OUT = arg("out", `${homedir()}/.local/state/abyme/documents/openrig/rig-${RIG}.md`);
const EVERY_MS = 60_000;

const get = async (path) => {
  const res = await fetch(`${DAEMON}${path}`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
};

async function abymeAgents() {
  try {
    const { stdout } = await run("abyme", ["call", "agents", "list", "--json"], { timeout: 10_000 });
    const parsed = JSON.parse(stdout);
    const list = Array.isArray(parsed) ? parsed : parsed.agents ?? parsed.result ?? [];
    return new Map(list.map((a) => [a.name, a]));
  } catch { return new Map(); }
}

const q = (s) => JSON.stringify(String(s ?? ""));            // an OpenUI / d2 string literal
const d2key = (s) => `"${String(s).replace(/"/g, "")}"`;
const agentName = (logicalId) => `${RIG}-${logicalId.replace(/\./g, "-")}`;
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const STATE_CLASS = { working: "working", blocked: "needs", stalled: "needs", idle: "idle", done: "idle" };

async function build() {
  const rigs = await get("/api/rigs");
  const rig = rigs.find((r) => r.name === RIG);
  if (!rig) return `---\ntitle: Rig ${RIG}\nfrom: openrig-seams\n---\n\n> [!WARNING] No rig named ${RIG}\n> The daemon at ${DAEMON} has no rig by that name.\n`;
  const [graph, status, inventory, agents] = await Promise.all([
    get(`/api/rigs/${rig.id}/graph`), get(`/api/rigs/${rig.id}/status`), get(`/api/rigs/${rig.id}/nodes`), abymeAgents(),
  ]);
  const byNode = new Map(inventory.map((n) => [n.nodeId, n]));
  const pods = graph.nodes.filter((n) => n.type === "podGroup");
  const seats = graph.nodes.filter((n) => n.type === "rigNode").map((n, i) => {
    const inv = byNode.get(n.id) ?? {};
    const name = agentName(n.data.logicalId);
    const agent = agents.get(name);
    return {
      id: n.id, i, pod: n.parentId, logicalId: n.data.logicalId, member: n.data.logicalId.split(".").slice(1).join("."),
      podNs: n.data.logicalId.split(".")[0], runtime: n.data.runtime ?? "?", kind: inv.attachmentType ?? "tmux",
      session: n.data.canonicalSessionName, running: inv.sessionStatus === "running",
      pending: n.data.pendingWorkCount ?? 0, active: n.data.inProgressWorkCount ?? 0, blocked: n.data.blockedWorkCount ?? 0,
      agentName: name, agentId: agent?.id ?? null, snapshot: agent?.status ?? "unknown",
    };
  });
  const seatById = new Map(seats.map((s) => [s.id, s]));
  const queued = seats.reduce((n, s) => n + s.pending + s.active, 0);
  const blockedWork = seats.reduce((n, s) => n + s.blocked, 0);
  const running = seats.filter((s) => s.running).length;
  const kinds = [...new Set(seats.map((s) => s.kind))];
  const now = new Date();
  const stamp = now.toLocaleString("en-AU", { dateStyle: "medium", timeStyle: "short" });

  // Live per-seat agent queries, shared by the header and the seat tables.
  const queries = seats.map((s) => `a${s.i} = Query("agents.agent", {agent: ${q(s.agentName)}}, {shown: "unknown", needs: null, doing: null, last_line: null, context_percent: null}, 1)`);
  const count = (expr) => seats.map((s) => `(${expr(`a${s.i}`)} ? 1 : 0)`).join(" + ") || "0";
  const working = count((a) => `${a}.shown == "working"`);
  const needs = count((a) => `${a}.needs != null`);

  const header = [
    "```openui",
    "root = Stack([title, counts])",
    `title = Stack([TagBlock([${q(running === seats.length ? "running" : `${running}/${seats.length} running`)}, ${q(plural(pods.length, "pod"))}, ${q(plural(seats.length, "seat"))}, ${q(kinds.join(" · "))}])])`,
    `counts = Grid([Stat("Seats running", ${q(`${running}/${seats.length}`)}), Stat("Working", ${working}), Stat("Needs you", ${needs}), Stat("Queued", ${queued}), Stat("Blocked work", ${blockedWork})], 5)`,
    ...queries,
    "```",
  ].join("\n");

  // Topology: pods as boxes, seats inside, coloured by the agent's state at this run.
  const d2 = ["```d2", "direction: right", "classes: {",
    '  working: {style: {fill: "#dff5e3"; stroke: "#2e9e4f"; font-color: "#111"}}',
    '  idle: {style: {fill: "#f2f2f2"; stroke: "#999"; font-color: "#111"}}',
    '  needs: {style: {fill: "#fff1d6"; stroke: "#d98a00"; stroke-width: 3; font-color: "#111"}}',
    '  unknown: {style: {fill: "#e9e9ef"; stroke: "#777"; stroke-dash: 3; font-color: "#111"}}',
    "}"];
  for (const pod of pods) {
    const inPod = seats.filter((s) => s.pod === pod.id);
    d2.push(`${d2key(pod.data.podNamespace)}: ${q(pod.data.podLabel ?? pod.data.podNamespace)} {`);
    for (const s of inPod) {
      const work = s.pending + s.active ? `\\n${s.pending + s.active} queued` : "";
      d2.push(`  ${d2key(s.member)}: "${s.member}\\n${s.runtime} · ${s.kind}${work}" {class: ${STATE_CLASS[s.snapshot] ?? "unknown"}}`);
    }
    d2.push("}");
  }
  for (const e of graph.edges) {
    const a = seatById.get(e.source), b = seatById.get(e.target);
    if (!a || !b) continue;
    const dashed = e.label === "delegates_to" || e.label === "spawned_by" ? "" : " {style.stroke-dash: 4}";
    d2.push(`${d2key(a.podNs)}.${d2key(a.member)} -> ${d2key(b.podNs)}.${d2key(b.member)}: ${e.label}${dashed}`);
  }
  d2.push("```");

  // Seats by pod: one tab each, live state per row.
  const tabs = pods.map((pod, p) => {
    const inPod = seats.filter((s) => s.pod === pod.id);
    const col = (label, cells, type) => `Col(${q(label)}, [${cells.join(", ")}]${type ? `, ${q(type)}` : ""})`;
    const table = `Table([${[
      col("Seat", inPod.map((s) => q(s.logicalId))),
      col("Agent", inPod.map((s) => `Tag(a${s.i}.shown, null, "sm", a${s.i}.shown == "working" ? "success" : (a${s.i}.needs != null ? "warning" : "neutral"))`)),
      col("Doing", inPod.map((s) => `a${s.i}.doing ? a${s.i}.doing : "—"`)),
      col("Queue", inPod.map((s) => q(s.blocked ? `${s.pending + s.active} (+${s.blocked} blocked)` : `${s.pending + s.active}`))),
      col("Context", inPod.map((s) => `a${s.i}.context_percent != null ? a${s.i}.context_percent + "%" : "—"`)),
      col("", inPod.map((s) => s.agentId ? `Button("Open", @OpenUrl(${q(`abyme:chat?agent=${encodeURIComponent(s.agentId)}`)}), "secondary", "normal", "small")` : `Text("no agent", "muted")`), "action"),
    ].join(", ")}])`;
    return { def: `t${p} = TabItem(${q(pod.data.podNamespace)}, ${q(pod.data.podLabel ?? pod.data.podNamespace)}, [${table}])`, ref: `t${p}` };
  });
  const seatsBlock = ["```openui", `root = Tabs([${tabs.map((t) => t.ref).join(", ")}])`, ...tabs.map((t) => t.def), ...queries, "```"].join("\n");

  // Restore readiness, from the status route: what a restore would do now, not the seats' current state.
  const blockedSeats = (status.perSeat ?? []).filter((s) => s.blocked);
  const reasons = [...new Set(blockedSeats.map((s) => s.reason).filter(Boolean))];
  const restore = blockedSeats.length
    ? `> [!WARNING] A restore would stop at ${plural(blockedSeats.length, "seat")}\n> ${reasons.join(" ")}\n> This is what \`rig restore\` would do, not what the seats are doing now.`
    : `> [!NOTE] Restore\n> Every seat can be restored as it is.`;

  return [
    "---", `title: Rig ${RIG}`, "from: openrig-seams", "width: 960", "---", "",
    `Updated ${stamp} from the OpenRig daemon at \`${DAEMON}\`; rewritten every minute. Seat activity follows abyme live.`, "",
    header, "", "## Topology", "",
    "Pods are boxes; solid arrows are `delegates_to`, dashed are every other edge. Colour is each seat's agent at the last rewrite.", "",
    d2.join("\n"), "", "## Seats", "", seatsBlock, "", "## Restore", "", restore, "",
  ].join("\n");
}

async function once() {
  let body;
  try { body = await build(); }
  catch (err) {
    body = `---\ntitle: Rig ${RIG}\nfrom: openrig-seams\n---\n\n> [!CAUTION] The daemon did not answer\n> ${String(err.message ?? err)} (at ${new Date().toISOString()}). The page will retry in a minute.\n`;
  }
  const prior = await readFile(OUT, "utf8").catch(() => "");
  if (prior === body) return;
  await writeFile(`${OUT}.tmp`, body);
  await rename(`${OUT}.tmp`, OUT);
}

await once();
if (process.argv.includes("--watch")) setInterval(() => { once().catch((e) => console.error(e)); }, EVERY_MS);
