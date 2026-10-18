// Fork branch `abyme` only: the daemon entry abyme runs as its `openrig` process
// (`.abyme/processes.ts`). Every seat is an abyme agent, reached through the openrig plugin, so
// this daemon needs no tmux and writes nothing outside OPENRIG_HOME: HOME is OPENRIG_HOME for it
// and every child, it binds loopback only, and it starts no tmux poller, discovery or kernel rig.
// Started directly (never `rig daemon start`), so the CLI's tmux preflight never runs.
import fs from "node:fs";
import nodePath from "node:path";
import { AbymeSeatKind } from "./abyme/seat-kind.js";
import { confineToHome } from "./abyme/home.js";

async function main(): Promise<void> {
  const configured = process.env.OPENRIG_HOME?.trim();
  if (!configured) {
    console.error("openrig-abyme: OPENRIG_HOME is required: the folder this daemon keeps its state in, which it also uses as HOME.");
    process.exit(1);
  }
  const home = nodePath.resolve(configured);
  fs.mkdirSync(home, { recursive: true });
  for (const note of confineToHome(process.env, home)) console.log(`[openrig-abyme] ${note}`);

  // Imported only now: these read OPENRIG_HOME and HOME as they load.
  const { removeParentSessionEnv } = await import("./domain/parent-session-env.js");
  removeParentSessionEnv(process.env);
  const { startServer } = await import("./index.js");
  const { abymeRoutes } = await import("./abyme/routes.js");

  const kind = new AbymeSeatKind({ home });
  await startServer(undefined, {
    seatKinds: [kind],
    defaultSeatKind: kind.kind,
    onDatabase: (db) => kind.attach(db),
    routes: (deps) => ({
      "/api/abyme": abymeRoutes({
        db: deps.rigRepo.db, kind, rigRepo: deps.rigRepo, sessionRegistry: deps.sessionRegistry, eventBus: deps.eventBus,
        rebindLifecycle: (nodeId) => deps.tmuxAdapter.deliveryGuard?.rebindLifecycle(nodeId),
      }),
    }),
    paneless: true,
  });
  console.log(`[openrig-abyme] home ${home}`);
}

void main().catch((err: unknown) => {
  console.error(`openrig-abyme: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
