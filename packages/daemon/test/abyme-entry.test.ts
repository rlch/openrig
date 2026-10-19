// Fork branch `abyme`: the daemon entry (src/abyme.ts) as a real process, with no tmux on PATH and
// a scratch HOME standing in for the operator's. A rig comes up, a seat takes a message and the rig
// goes down; the HOME's ~/.claude, ~/.codex and ~/.tmux.conf must be byte for byte as before.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DAEMON = path.resolve(HERE, "..");
const ENTRY = path.join(DAEMON, "src", "abyme.ts");
const TSX = path.resolve(DAEMON, "..", "..", "node_modules", "tsx", "dist", "loader.mjs");
const TOKEN = "entry-token";

/** Every file under `dir` with its sha256, so a run can be compared byte for byte. */
function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(dir, p)] = createHash("sha256").update(fs.readFileSync(p)).digest("hex");
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => { const { port } = s.address() as AddressInfo; s.close(() => resolve(port)); });
  });
}

let scratch: string;
let fakeHome: string;
let openrigHome: string;
let specDir: string;
let child: ChildProcess | null = null;
let log = "";
let plugin: http.Server;
const pluginCalls: Array<{ verb: string; body: Record<string, unknown> }> = [];
let homeBefore: Record<string, string>;
let specBefore: Record<string, string>;

/** PATH with node and the system folders only: no tmux, which lives in Homebrew. */
const bareEnvPath = [path.dirname(process.execPath), "/usr/bin", "/bin"].join(":");

function run(env: Record<string, string>): ChildProcess {
  log = "";
  const p = spawn(process.execPath, ["--import", TSX, ENTRY], { cwd: scratch, env, stdio: ["ignore", "pipe", "pipe"] });
  p.stdout!.on("data", (d) => { log += d; });
  p.stderr!.on("data", (d) => { log += d; });
  return p;
}

async function until(what: () => boolean, ms: number, label: string): Promise<void> {
  const end = Date.now() + ms;
  while (!what()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}; log:\n${log}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

beforeAll(async () => {
  scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "abyme-entry-")));
  fakeHome = path.join(scratch, "operator-home");
  openrigHome = path.join(scratch, "openrig-home");
  for (const d of [".claude", ".codex"]) fs.mkdirSync(path.join(fakeHome, d), { recursive: true });
  fs.writeFileSync(path.join(fakeHome, ".claude", "settings.json"), '{"hooks":{}}\n');
  fs.writeFileSync(path.join(fakeHome, ".claude", "CLAUDE.md"), "# mine\n");
  fs.writeFileSync(path.join(fakeHome, ".codex", "config.toml"), 'model = "x"\n');
  fs.writeFileSync(path.join(fakeHome, ".tmux.conf"), "set -g mouse on\n");
  homeBefore = tree(fakeHome);

  // The scenario fixture's one-pod stub rig, copied so its folder can be checked afterwards too.
  specDir = path.join(scratch, "spec");
  fs.cpSync(path.join(HERE, "fixtures", "scenarios"), specDir, { recursive: true });
  specBefore = tree(specDir);

  plugin = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const verb = (req.url ?? "").replace("/api/openrig/seat/", "");
      pluginCalls.push({ verb, body: raw ? JSON.parse(raw) : {} });
      const answer: Record<string, unknown> = { start: { agent: "acp:e1", space: "group:scn" }, probe: { present: true, status: "idle" },
        deliver: { ok: true }, capture: { text: "done" }, stop: { gone: true } }[verb] ?? { error: "no route" };
      res.writeHead(req.headers.authorization === `Bearer ${TOKEN}` ? 200 : 401, { "content-type": "application/json" });
      res.end(JSON.stringify(answer));
    });
  });
  await new Promise<void>((r) => plugin.listen(0, "127.0.0.1", r));
  fs.mkdirSync(openrigHome, { recursive: true });
  fs.writeFileSync(path.join(openrigHome, "abyme.json"), JSON.stringify({ url: `http://127.0.0.1:${(plugin.address() as AddressInfo).port}`, token: TOKEN }));
});

afterAll(async () => {
  if (child && child.exitCode === null) { child.kill("SIGTERM"); await new Promise((r) => child!.once("exit", r)); }
  await new Promise<void>((r) => plugin.close(() => r()));
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe("the abyme daemon entry", () => {
  it("has no tmux on the PATH it runs with", () => {
    expect(spawnSync("/bin/sh", ["-c", "command -v tmux"], { env: { PATH: bareEnvPath } }).status).not.toBe(0);
  });

  it("refuses to start without OPENRIG_HOME", () => {
    const r = spawnSync(process.execPath, ["--import", TSX, ENTRY], { env: { PATH: bareEnvPath, HOME: fakeHome }, encoding: "utf-8", timeout: 60_000 });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("OPENRIG_HOME is required");
  }, 70_000);

  it("runs a rig without tmux and leaves the home alone", async () => {
    const port = await freePort();
    child = run({ PATH: bareEnvPath, HOME: fakeHome, OPENRIG_HOME: openrigHome, OPENRIG_PORT: String(port),
      CODEX_HOME: path.join(fakeHome, ".codex"), CLAUDE_CONFIG_DIR: path.join(fakeHome, ".claude") });
    await until(() => /listening on http:\/\/127\.0\.0\.1:/.test(log) && /startup reconcile:/.test(log), 90_000, "the daemon to listen");
    const base = `http://127.0.0.1:${port}`;
    expect(log).toMatch(/startup reconcile: rigs=0 checked=0 detached=0 errors=0/);
    expect(log).not.toMatch(/listening on http:\/\/(?!127\.0\.0\.1)/);

    const up = await fetch(`${base}/api/up`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceRef: path.join(specDir, "topo-stub-baton.yaml"), autoApprove: true }) });
    const upBody = await up.json() as { rigId?: string; status?: string };
    expect(up.status, JSON.stringify(upBody)).toBeLessThan(300);
    expect(pluginCalls.find((c) => c.verb === "start")?.body).toMatchObject({ rigName: "scn-baton", pod: "dev", member: "worker", session: "dev-worker@scn-baton" });

    const seats = await (await fetch(`${base}/api/abyme/seats`)).json() as Array<{ session: string; agent: string }>;
    expect(seats).toEqual([expect.objectContaining({ session: "dev-worker@scn-baton", agent: "acp:e1" })]);

    const sent = await fetch(`${base}/api/transport/send`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ session: "dev-worker@scn-baton", text: "hello seat" }) });
    expect(sent.status).toBe(200);
    expect(pluginCalls.some((c) => c.verb === "deliver" && c.body.text === "hello seat")).toBe(true);

    // A restart with the seat running: the boot reconcile asks the plugin, not tmux.
    child.kill("SIGTERM");
    await new Promise((r) => child!.once("exit", r));
    child = run({ PATH: bareEnvPath, HOME: fakeHome, OPENRIG_HOME: openrigHome, OPENRIG_PORT: String(port) });
    await until(() => /listening on http:\/\/127\.0\.0\.1:/.test(log) && /startup reconcile:/.test(log), 90_000, "the daemon to listen again");
    expect(log).toMatch(/startup reconcile: rigs=1 checked=1 detached=0 errors=0/);
    expect(pluginCalls.filter((c) => c.verb === "probe").length).toBeGreaterThan(0);

    const rigId = upBody.rigId ?? (await (await fetch(`${base}/api/rigs`)).json() as Array<{ id: string }>)[0]!.id;
    const down = await fetch(`${base}/api/down`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rigId }) });
    expect(down.status, await down.clone().text()).toBeLessThan(300);
    expect(pluginCalls.some((c) => c.verb === "stop" && c.body.agent === "acp:e1")).toBe(true);

    child.kill("SIGTERM");
    await new Promise((r) => child!.once("exit", r));

    expect(log).not.toMatch(/tmux[^\n]*(not found|ENOENT|No such file)/i);
    expect(tree(fakeHome)).toEqual(homeBefore);
    expect(tree(specDir)).toEqual(specBefore);
    // Everything else it wrote is in OPENRIG_HOME: the scratch folder holds nothing new beside these.
    expect(fs.readdirSync(scratch).sort()).toEqual(["openrig-home", "operator-home", "spec"]);
  }, 180_000);

  it("leaves a claude-code seat's cwd byte for byte as it was, through rig up, add-member and a restore", async () => {
    const dir = path.join(scratch, "cwd-rig");
    const cwd = path.join(dir, "checkout");
    fs.mkdirSync(path.join(cwd, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "CLAUDE.md"), "# the operator's own\n");
    fs.writeFileSync(path.join(cwd, "AGENTS.md"), "# theirs too\n");
    fs.writeFileSync(path.join(cwd, ".claude", "settings.json"), "{}\n");
    fs.mkdirSync(path.join(dir, "agents", "worker"), { recursive: true });
    fs.copyFileSync(path.join(specDir, "agents", "worker", "agent.yaml"), path.join(dir, "agents", "worker", "agent.yaml"));
    fs.writeFileSync(path.join(dir, "culture.md"), "CULTURE-MARKER: work in small steps.\n");
    fs.writeFileSync(path.join(dir, "rig.yaml"), [
      'version: "0.2"', "name: cwdrig", "culture_file: culture.md", "pods:", "  - id: dev", "    label: Dev", "    members:",
      "      - id: build", '        agent_ref: "local:agents/worker"', "        profile: default", "        runtime: claude-code", `        cwd: ${cwd}`,
      "    edges: []", "",
    ].join("\n"));
    const before = tree(cwd);

    const port = await freePort();
    child = run({ PATH: bareEnvPath, HOME: fakeHome, OPENRIG_HOME: openrigHome, OPENRIG_PORT: String(port) });
    await until(() => /listening on http:\/\/127\.0\.0\.1:/.test(log), 90_000, "the daemon to listen");
    const base = `http://127.0.0.1:${port}`;
    pluginCalls.length = 0;

    const up = await fetch(`${base}/api/up`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceRef: path.join(dir, "rig.yaml"), autoApprove: true }) });
    const upBody = await up.json() as { rigId?: string };
    expect(up.status, JSON.stringify(upBody)).toBeLessThan(300);
    expect(tree(cwd)).toEqual(before);
    const culture = (calls: typeof pluginCalls) => calls.some((c) => c.verb === "deliver" && String(c.body.text).includes("CULTURE-MARKER"));
    expect(culture(pluginCalls), JSON.stringify(pluginCalls)).toBe(true);
    // Both cultures ride in the seat's first message.
    const first = pluginCalls.find((c) => c.verb === "deliver")!;
    expect(String(first.body.text)).toContain("# OpenRig default culture");
    expect(String(first.body.text)).toContain("CULTURE-MARKER");

    pluginCalls.length = 0;
    const rigs = await (await fetch(`${base}/api/rigs`)).json() as Array<{ id: string; name: string }>;
    const rigId = upBody.rigId ?? rigs.find((r) => r.name === "cwdrig")!.id;
    const added = await fetch(`${base}/api/rigs/${rigId}/pods/dev/members`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ rigRoot: dir, member: { id: "review", agent_ref: "local:agents/worker", profile: "default", runtime: "claude-code", cwd } }) });
    expect(added.status, await added.clone().text()).toBeLessThan(300);
    expect(pluginCalls.some((c) => c.verb === "start" && c.body.member === "review")).toBe(true);
    // The seat added later gets the rig's culture_file, as rig up recorded it, and the default culture.
    const addedFirst = pluginCalls.find((c) => c.verb === "deliver")!;
    expect(String(addedFirst.body.text)).toContain("# OpenRig default culture");
    expect(String(addedFirst.body.text)).toContain("CULTURE-MARKER");
    // The context monitor and every later poll: still nothing in the cwd.
    await new Promise((r) => setTimeout(r, 3000));
    expect(tree(cwd)).toEqual(before);

    // Down, then up by name: a restore, as on the live rig. With no --fresh it relaunches both seats
    // fresh (an abyme agent has no resume token), through the plugin.
    const down = await fetch(`${base}/api/down`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rigId }) });
    expect(down.status, await down.clone().text()).toBeLessThan(300);
    pluginCalls.length = 0;
    const again = await fetch(`${base}/api/up`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceRef: "cwdrig", autoApprove: true }) });
    const againBody = await again.text();
    expect(again.status, againBody).toBeLessThan(300);
    expect(againBody).not.toContain("No tmux session bound");
    expect(againBody).not.toContain("guidanceGaps");
    expect(pluginCalls.filter((c) => c.verb === "start").length, againBody).toBe(2);
    await new Promise((r) => setTimeout(r, 2000));
    expect(tree(cwd)).toEqual(before);
    expect(pluginCalls.some((c) => c.verb === "deliver" && String(c.body.text).includes("# OpenRig default culture")), againBody).toBe(true);
    expect(tree(cwd)).toEqual(before);

    child.kill("SIGTERM");
    await new Promise((r) => child!.once("exit", r));
    expect(tree(fakeHome)).toEqual(homeBefore);
  }, 180_000);
  it("brings two rigs up from one spec under names of their own, launches none, launches one later with its env, and deletes it", async () => {
    const port = await freePort();
    child = run({ PATH: bareEnvPath, HOME: fakeHome, OPENRIG_HOME: openrigHome, OPENRIG_PORT: String(port) });
    await until(() => /listening on http:\/\/127\.0\.0\.1:/.test(log), 90_000, "the daemon to listen");
    const base = `http://127.0.0.1:${port}`;
    const post = (route: string, body: unknown) => fetch(`${base}${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    pluginCalls.length = 0;

    const spec = path.join(specDir, "topo-stub-baton.yaml");
    const ids: Record<string, string> = {};
    for (const rigName of ["quiet-spaces", "rig-per-feature"]) {
      const up = await post("/api/up", { sourceRef: spec, autoApprove: true, rigName, env: { ABYME_BRANCH: rigName, ABYME_BASE: "main" }, launch: false });
      const body = await up.json() as { rigId?: string };
      expect(up.status, JSON.stringify(body)).toBeLessThan(300);
      ids[rigName] = body.rigId!;
    }
    expect(pluginCalls.filter((c) => c.verb === "start")).toEqual([]);
    const ps = await (await fetch(`${base}/api/ps`)).json() as Array<{ name: string; runningCount: number }>;
    expect(ps.filter((r) => r.name === "quiet-spaces" || r.name === "rig-per-feature").map((r) => r.runningCount)).toEqual([0, 0]);
    expect(ps.some((r) => r.name === "scn-baton" && r.runningCount > 0)).toBe(false);

    // The flow names each unlaunched seat by the session it will have.
    const flow = await (await fetch(`${base}/api/abyme/flow?rig=${ids["quiet-spaces"]}`)).json() as { seats: Array<{ session: string; agent: string | null }> };
    expect(flow.seats).toEqual([expect.objectContaining({ session: "dev-worker@quiet-spaces", agent: null })]);

    // A name of the wrong shape is refused before anything is made.
    expect((await post("/api/up", { sourceRef: spec, rigName: "two words", launch: false })).status).toBe(400);

    // An hour later: the seat launches with the env its rig was saved with.
    const launched = await post("/api/abyme/launch", { rigId: ids["quiet-spaces"], member: "dev.worker", rigRoot: specDir });
    const lb = await launched.json() as { session?: string };
    expect(launched.status, JSON.stringify(lb)).toBe(200);
    expect(lb.session).toBe("dev-worker@quiet-spaces");
    const start = pluginCalls.find((c) => c.verb === "start")!;
    expect(start.body).toMatchObject({ rigName: "quiet-spaces", session: "dev-worker@quiet-spaces", branch: "quiet-spaces", base: "main" });
    expect(pluginCalls.some((c) => c.verb === "deliver" && String(c.body.text).includes("# OpenRig default culture"))).toBe(true);
    // Twice is refused: it is bound.
    expect((await post("/api/abyme/launch", { rigId: ids["quiet-spaces"], member: "dev.worker", rigRoot: specDir })).status).toBe(409);
    // The other rig's seat is still one bind may take.
    const bound = await post("/api/abyme/bind", { rigId: ids["rig-per-feature"], member: "dev.worker", agent: "acp:other" });
    expect(bound.status, await bound.clone().text()).toBe(200);

    for (const rigId of Object.values(ids)) {
      const down = await post("/api/down", { rigId, delete: true });
      expect(down.status, await down.clone().text()).toBeLessThan(300);
    }
    expect(pluginCalls.some((c) => c.verb === "stop" && c.body.agent === "acp:e1")).toBe(true);
    const after = await (await fetch(`${base}/api/ps`)).json() as Array<{ name: string }>;
    expect(after.map((r) => r.name)).not.toContain("quiet-spaces");
    expect(after.map((r) => r.name)).not.toContain("rig-per-feature");

    child.kill("SIGTERM");
    await new Promise((r) => child!.once("exit", r));
  }, 180_000);
});
