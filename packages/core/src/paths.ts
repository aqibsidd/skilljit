import os from "node:os";
import path from "node:path";

/** Where the local skilljit catalog db lives: ~/.skilljit/catalog.db. */
export function defaultCatalogPath(): string {
  const home = process.env.SKILLJIT_HOME ?? os.homedir();
  return path.join(home, ".skilljit", "catalog.db");
}
