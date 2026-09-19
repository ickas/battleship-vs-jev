import { existsSync } from 'node:fs';

/**
 * Loads .env from the project root if present, without adding a dependency.
 * Node's own loader is used; existing environment variables win, so an
 * explicitly exported key is never silently overridden by a stale file.
 */
let loaded = false;

export function loadEnv(path = '.env'): void {
  if (loaded || !existsSync(path)) return;
  loaded = true;
  try {
    process.loadEnvFile(path);
  } catch (error) {
    console.warn(
      `Could not read ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
