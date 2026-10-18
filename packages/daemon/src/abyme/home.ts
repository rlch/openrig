// Fork branch `abyme` only: the environment the abyme daemon entry (src/abyme.ts) runs in.
import { ABYME_ENDPOINT_FILE, readAbymeEndpoint } from "./seat-kind.js";

/** The port when OPENRIG_PORT is unset: not 7433, so an installed OpenRig keeps its own. */
export const ABYME_DEFAULT_PORT = 7439;

/** Point this process's environment at `home` alone. Returns what to log. */
export function confineToHome(env: NodeJS.ProcessEnv, home: string): string[] {
  const notes: string[] = [];
  env.OPENRIG_HOME = home;
  env.HOME = home;
  // Each of these would name a folder in the operator's real home; unset, they follow HOME.
  for (const name of ["CODEX_HOME", "CLAUDE_CONFIG_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME",
    "OPENRIG_DB", "RIGGED_HOME", "RIGGED_DB", "TMUX", "TMUX_PANE"]) {
    if (env[name] !== undefined) { notes.push(`unset ${name}`); delete env[name]; }
  }
  env.OPENRIG_BIND_HOST = "127.0.0.1";
  env.OPENRIG_NO_KERNEL = "1";
  env.OPENRIG_PORT ||= String(ABYME_DEFAULT_PORT);
  // abyme posts each seat's activity with the plugin's token, so the daemon expects that one.
  const endpoint = readAbymeEndpoint(home);
  if (endpoint) env.OPENRIG_ACTIVITY_HOOK_TOKEN = endpoint.token;
  else notes.push(`no ${ABYME_ENDPOINT_FILE} in ${home} yet: abyme seats cannot be reached until the plugin writes it`);
  return notes;
}
