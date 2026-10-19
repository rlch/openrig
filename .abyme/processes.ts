import type { ProcessFile } from "@abyme/processes";

// Fork branch `abyme` only: the OpenRig daemon abyme's openrig plugin places. abyme evaluates this
// file in a sandbox with no environment or `os`, so OPENRIG_HOME is written out in full.
export default {
  openrig: {
    cmd: "npm run build -w packages/daemon && node packages/daemon/dist/abyme.js",
    env: { OPENRIG_HOME: "/Users/rjm/.local/share/openrig-abyme", OPENRIG_BIND_HOST: "127.0.0.1" },
  },
  // The daemon's typecheck and tests, the gate a change to it passes before landing.
  "daemon-check": { cmd: "npx tsc -p packages/daemon --noEmit && npm test -w packages/daemon" },
} satisfies ProcessFile;
