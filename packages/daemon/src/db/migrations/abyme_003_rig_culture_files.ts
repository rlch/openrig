import type { Migration } from "../migrate.js";

// Fork branch `abyme` only. The culture_file a rig came up with, as an absolute path, so a seat
// added later (add-member) gets the same culture as the seats rig up made.
export const rigCultureFilesSchema: Migration = {
  name: "abyme_003_rig_culture_files.sql",
  sql: `
    CREATE TABLE IF NOT EXISTS rig_culture_files (
      rig_id TEXT PRIMARY KEY REFERENCES rigs(id) ON DELETE CASCADE,
      path   TEXT NOT NULL
    );
  `,
};
