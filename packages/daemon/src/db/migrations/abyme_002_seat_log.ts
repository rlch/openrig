import type { Migration } from "../migrate.js";

// Fork branch `abyme` only. Every seat an abyme agent has held, by its session: its rig, node,
// member and pod, kept after the node is removed so the Flow view keeps a removed seat's lane
// while its work is in the window (a change seat, gone once its branch lands).
export const abymeSeatLogSchema: Migration = {
  name: "abyme_002_seat_log.sql",
  sql: `
    CREATE TABLE IF NOT EXISTS abyme_seat_log (
      session_name TEXT PRIMARY KEY,
      rig_id       TEXT NOT NULL,
      node_id      TEXT NOT NULL,
      member       TEXT NOT NULL,
      pod_id       TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_abyme_seat_log_rig ON abyme_seat_log (rig_id);
    INSERT OR IGNORE INTO abyme_seat_log (session_name, rig_id, node_id, member, pod_id)
      SELECT s.session_name, n.rig_id, n.id, n.logical_id, n.pod_id FROM abyme_seats s JOIN nodes n ON n.id = s.node_id;
  `,
};
