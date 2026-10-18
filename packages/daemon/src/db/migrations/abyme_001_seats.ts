import type { Migration } from "../migrate.js";

// Fork branch `abyme` only. Which abyme agent holds each seat, and which abyme space each rig is,
// so the abyme seat kind (src/abyme/seat-kind.ts) can reach a seat's agent and the plugin keeps
// no copy of the join. Named outside upstream's numbering so a rebase never collides with it.
export const abymeSeatsSchema: Migration = {
  name: "abyme_001_seats.sql",
  sql: `
    CREATE TABLE IF NOT EXISTS abyme_seats (
      session_name TEXT PRIMARY KEY,
      node_id      TEXT NOT NULL,
      agent_id     TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_abyme_seats_agent ON abyme_seats (agent_id);
    CREATE TABLE IF NOT EXISTS abyme_rigs (
      rig_id   TEXT PRIMARY KEY,
      space_id TEXT NOT NULL
    );
  `,
};
