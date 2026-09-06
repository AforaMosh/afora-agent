// Test helpers for environment variable setup and restoration.
import path from "node:path";

/** Sets a test-owned env key; callers must capture/restore the key scope. */
export function setTestEnvValue(key: string, value: string): void {
  Reflect.set(process.env, key, value);
}

/** Deletes a test-owned env key; callers must capture/restore the key scope. */
export function deleteTestEnvValue(key: string): void {
  Reflect.deleteProperty(process.env, key);
}

// afora-compat: the debrand gave every AFORA_* variable an OPENCLAW_* twin
// (infra/afora-env-alias.ts), and normalizeEnv() fills whichever one is missing. A scope that
// names one spelling therefore only half-scopes the variable: code under test creates the twin,
// the twin outlives the scope, and the next normalizeEnv() reads the value straight back into
// the name the test just restored. Scoping the pair keeps "restore exact prior state" true.
function withAliasTwins(keys: readonly string[]): string[] {
  const scoped = new Set<string>();
  for (const key of keys) {
    scoped.add(key);
    if (key.startsWith("AFORA_")) {
      scoped.add(`OPENCLAW_${key.slice("AFORA_".length)}`); // afora-compat: OPENCLAW_* twin
    } else if (key.startsWith("OPENCLAW_")) {
      scoped.add(`AFORA_${key.slice("OPENCLAW_".length)}`);
    }
  }
  return [...scoped];
}

/** Captures selected process.env keys, and their alias twins, so tests can restore exact prior state. */
export function captureEnv(keys: string[]) {
  const snapshot = new Map<string, string | undefined>();
  for (const key of withAliasTwins(keys)) {
    snapshot.set(key, process.env[key]);
  }

  return {
    restore() {
      for (const [key, value] of snapshot) {
        if (value === undefined) {
          deleteTestEnvValue(key);
        } else {
          setTestEnvValue(key, value);
        }
      }
    },
  };
}

function applyEnvValues(env: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      deleteTestEnvValue(key);
    } else {
      setTestEnvValue(key, value);
    }
  }
}

const PATH_RESOLUTION_ENV_KEYS = [
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "AFORA_HOME",
  "AFORA_STATE_DIR",
  "AFORA_BUNDLED_PLUGINS_DIR",
  "AFORA_DISABLE_BUNDLED_PLUGINS",
] as const;

// Windows home resolution depends on split drive/path env vars, not only HOME.
function resolveWindowsHomeParts(homeDir: string): { homeDrive?: string; homePath?: string } {
  if (process.platform !== "win32") {
    return {};
  }
  const match = homeDir.match(/^([A-Za-z]:)(.*)$/);
  if (!match) {
    return {};
  }
  return {
    homeDrive: match[1],
    homePath: match[2] || "\\",
  };
}

export function createPathResolutionEnv(
  homeDir: string,
  env: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  const resolvedHome = path.resolve(homeDir);
  const nextEnv: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: resolvedHome,
    USERPROFILE: resolvedHome,
    AFORA_HOME: undefined,
    AFORA_STATE_DIR: undefined,
    AFORA_BUNDLED_PLUGINS_DIR: undefined,
    AFORA_DISABLE_BUNDLED_PLUGINS: undefined,
  };

  const windowsHome = resolveWindowsHomeParts(resolvedHome);
  nextEnv.HOMEDRIVE = windowsHome.homeDrive;
  nextEnv.HOMEPATH = windowsHome.homePath;

  for (const [key, value] of Object.entries(env)) {
    nextEnv[key] = value;
  }

  return nextEnv;
}

export function withPathResolutionEnv<T>(
  homeDir: string,
  env: Record<string, string | undefined>,
  fn: (resolvedEnv: NodeJS.ProcessEnv) => T,
): T {
  const resolvedEnv = createPathResolutionEnv(homeDir, env);
  const scopedEnv: Record<string, string | undefined> = {};
  for (const key of new Set([...PATH_RESOLUTION_ENV_KEYS, ...Object.keys(env)])) {
    scopedEnv[key] = resolvedEnv[key];
  }
  return withEnv(scopedEnv, () => fn(resolvedEnv));
}

export function captureFullEnv() {
  const snapshot: Record<string, string | undefined> = { ...process.env };

  return {
    restore() {
      for (const key of Object.keys(process.env)) {
        if (!(key in snapshot)) {
          deleteTestEnvValue(key);
        }
      }
      for (const [key, value] of Object.entries(snapshot)) {
        if (value === undefined) {
          deleteTestEnvValue(key);
        } else {
          setTestEnvValue(key, value);
        }
      }
    },
  };
}

export function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const snapshot = captureEnv(Object.keys(env));
  try {
    applyEnvValues(env);
    return fn();
  } finally {
    snapshot.restore();
  }
}

export async function withEnvAsync<T>(
  env: Record<string, string | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  const snapshot = captureEnv(Object.keys(env));
  try {
    applyEnvValues(env);
    return await fn();
  } finally {
    snapshot.restore();
  }
}
