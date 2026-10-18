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
});
