// Covers runtime snapshot writes produced by config IO.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  projectConfigOntoRuntimeSourceSnapshot,
  resetConfigRuntimeState,
  setRuntimeConfigSnapshotRefreshHandler,
  setRuntimeConfigSnapshot,
} from "./io.js";
import { projectRuntimeConfigOntoSourceSnapshot } from "./runtime-source-projection.js";
import type { OpenClawConfig } from "./types.js";

function createSourceConfig(): OpenClawConfig {
  return {
    models: {
      providers: {
        openai: {
          baseUrl: "https://api.openai.com/v1",
          apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
          models: [],
        },
      },
    },
  };
}

function createRuntimeConfig(): OpenClawConfig {
  return {
    models: {
      providers: {
        openai: {
          baseUrl: "https://api.openai.com/v1",
          apiKey: "sk-runtime-resolved", // pragma: allowlist secret
          models: [],
        },
      },
    },
  };
}

function resetRuntimeConfigState(): void {
  setRuntimeConfigSnapshotRefreshHandler(null);
  resetConfigRuntimeState();
}

describe("runtime config snapshot writes", () => {
  beforeEach(() => {
    resetRuntimeConfigState();
  });

  afterEach(() => {
    resetRuntimeConfigState();
  });

  it("skips source projection for non-runtime-derived configs", () => {
    const sourceConfig: OpenClawConfig = {
      ...createSourceConfig(),
      gateway: {
        auth: {
          mode: "token",
        },
      },
    };
    const runtimeConfig: OpenClawConfig = {
      ...createRuntimeConfig(),
      gateway: {
        auth: {
          mode: "token",
        },
      },
    };
    const independentConfig: OpenClawConfig = {
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            apiKey: "sk-independent-config", // pragma: allowlist secret
            models: [],
          },
        },
      },
    };

    setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);
    const projected = projectConfigOntoRuntimeSourceSnapshot(independentConfig);
    expect(projected).toBe(independentConfig);
  });

  it("preserves a shifted authored-reference item after an identical duplicate is removed", () => {
    const sourceShape = {
      plugins: {
        entries: {
          demo: {
            config: {
              items: [
                { id: "duplicate" },
                { id: "duplicate" },
                { id: "target", token: "${TOKEN}", mode: "old" },
              ],
            },
          },
        },
      },
    };
    const runtime = structuredClone(sourceShape);
    const runtimeItems = runtime.plugins.entries.demo.config.items;
    runtimeItems[2] = { id: "target", token: "resolved-token", mode: "old" };
    const candidate = structuredClone(runtime);
    candidate.plugins.entries.demo.config.items = [
      { id: "duplicate" },
      { id: "target", token: "resolved-token", mode: "new" },
    ];

    expect(
      projectRuntimeConfigOntoSourceSnapshot({
        sourceSnapshot: sourceShape as unknown as OpenClawConfig,
        runtimeSnapshot: runtime as unknown as OpenClawConfig,
        candidate: candidate as unknown as OpenClawConfig,
      }),
    ).toEqual({
      ok: true,
      value: {
        plugins: {
          entries: {
            demo: {
              config: {
                items: [{ id: "duplicate" }, { id: "target", token: "${TOKEN}", mode: "new" }],
              },
            },
          },
        },
      },
    });
  });

  it("rejects removing one of duplicate resolved values with different authored identities", () => {
    const sourceShape = {
      plugins: {
        entries: {
          demo: {
            config: {
              items: ["${TOKEN}", "resolved-token", { id: "target", mode: "old" }],
            },
          },
        },
      },
    };
    const runtime = structuredClone(sourceShape);
    runtime.plugins.entries.demo.config.items[0] = "resolved-token";
    const candidate = structuredClone(runtime);
    candidate.plugins.entries.demo.config.items = ["resolved-token", { id: "target", mode: "new" }];

    expect(
      projectRuntimeConfigOntoSourceSnapshot({
        sourceSnapshot: sourceShape as unknown as OpenClawConfig,
        runtimeSnapshot: runtime as unknown as OpenClawConfig,
        candidate: candidate as unknown as OpenClawConfig,
      }),
    ).toEqual({
      ok: false,
      error: {
        code: "ambiguous-runtime-array",
        key: "plugins.entries.demo.config.items",
      },
    });
  });

  it("allows removing duplicate values with identical authored references", () => {
    expect(
      projectRuntimeConfigOntoSourceSnapshot({
        sourceSnapshot: { plugins: { allow: ["${TOKEN}", "${TOKEN}"] } },
        runtimeSnapshot: { plugins: { allow: ["resolved-token", "resolved-token"] } },
        candidate: { plugins: { allow: ["resolved-token"] } },
      }),
    ).toEqual({
      ok: true,
      value: { plugins: { allow: ["${TOKEN}"] } },
    });
  });

  it("rejects duplicating one resolved authored-reference array value", () => {
    expect(
      projectRuntimeConfigOntoSourceSnapshot({
        sourceSnapshot: { plugins: { allow: ["${TOKEN}"] } },
        runtimeSnapshot: { plugins: { allow: ["resolved-token"] } },
        candidate: { plugins: { allow: ["resolved-token", "resolved-token"] } },
      }),
    ).toEqual({
      ok: false,
      error: { code: "ambiguous-runtime-array", key: "plugins.allow" },
    });
  });

  it("preserves same-index authored duplicates when appending a new array value", () => {
    const sourceShape = {
      plugins: { entries: { demo: { config: { items: ["${A}", "${B}"] } } } },
    };
    const runtime = {
      plugins: { entries: { demo: { config: { items: ["same", "same"] } } } },
    };
    const candidate = structuredClone(runtime);
    candidate.plugins.entries.demo.config.items.push("new");

    expect(
      projectRuntimeConfigOntoSourceSnapshot({
        sourceSnapshot: sourceShape as unknown as OpenClawConfig,
        runtimeSnapshot: runtime as unknown as OpenClawConfig,
        candidate: candidate as unknown as OpenClawConfig,
      }),
    ).toEqual({
      ok: true,
      value: {
        plugins: { entries: { demo: { config: { items: ["${A}", "${B}", "new"] } } } },
      },
    });
  });

  it("rejects changing an array with no authored array counterpart", () => {
    expect(
      projectRuntimeConfigOntoSourceSnapshot({
        sourceSnapshot: { plugins: { entries: { demo: { config: {} } } } },
        runtimeSnapshot: {
          plugins: { entries: { demo: { config: { items: ["a", "b"] } } } },
        },
        candidate: {
          plugins: { entries: { demo: { config: { items: ["a", "c"] } } } },
        },
      }),
    ).toEqual({
      ok: false,
      error: { code: "ambiguous-runtime-array", key: "plugins.entries.demo.config.items" },
    });
  });

  it("rejects changing an array with runtime-only elements", () => {
    expect(
      projectRuntimeConfigOntoSourceSnapshot({
        sourceSnapshot: { plugins: { allow: [] } },
        runtimeSnapshot: { plugins: { allow: ["default"] } },
        candidate: { plugins: { allow: ["default", "new"] } },
      }),
    ).toEqual({
      ok: false,
      error: { code: "ambiguous-runtime-array", key: "plugins.allow" },
    });
  });

  it("allows an unambiguous candidate-only top-level section", () => {
    const runtime = { gateway: { mode: "local" as const } };
    expect(
      projectRuntimeConfigOntoSourceSnapshot({
        sourceSnapshot: runtime,
        runtimeSnapshot: runtime,
        candidate: { ...runtime, browser: { enabled: true } },
      }),
    ).toEqual({
      ok: true,
      value: { gateway: { mode: "local" }, browser: { enabled: true } },
    });
  });

  it("rejects same-length shifts across duplicate resolved authored references", () => {
    const sourceShape = {
      plugins: {
        entries: {
          demo: {
            config: { items: ["${A}", "${B}", "tail"] },
          },
        },
      },
    };
    const runtime = structuredClone(sourceShape);
    runtime.plugins.entries.demo.config.items = ["same", "same", "tail"];
    const candidate = structuredClone(runtime);
    candidate.plugins.entries.demo.config.items = ["tail", "same", "same"];

    expect(
      projectRuntimeConfigOntoSourceSnapshot({
        sourceSnapshot: sourceShape as unknown as OpenClawConfig,
        runtimeSnapshot: runtime as unknown as OpenClawConfig,
        candidate: candidate as unknown as OpenClawConfig,
      }),
    ).toEqual({
      ok: false,
      error: {
        code: "ambiguous-runtime-array",
        key: "plugins.entries.demo.config.items",
      },
    });
  });

  it("rejects an edited reorder of multiple unkeyed authored-reference items", () => {
    const sourceShape = {
      plugins: {
        entries: {
          demo: {
            config: {
              accounts: [
                { name: "a", token: "${A}" },
                { name: "b", token: "${B}" },
              ],
            },
          },
        },
      },
    };
    const runtime = structuredClone(sourceShape);
    runtime.plugins.entries.demo.config.accounts = [
      { name: "a", token: "resolved-a" },
      { name: "b", token: "resolved-b" },
    ];
    const candidate = structuredClone(runtime);
    candidate.plugins.entries.demo.config.accounts = [
      { name: "b", token: "resolved-b", enabled: true },
      { name: "a", token: "resolved-a", enabled: true },
    ];

    expect(
      projectRuntimeConfigOntoSourceSnapshot({
        sourceSnapshot: sourceShape as unknown as OpenClawConfig,
        runtimeSnapshot: runtime as unknown as OpenClawConfig,
        candidate: candidate as unknown as OpenClawConfig,
      }),
    ).toEqual({
      ok: false,
      error: {
        code: "ambiguous-runtime-array",
        key: "plugins.entries.demo.config.accounts",
      },
    });
  });

  it("preserves authored references across a unique map-entry rename", () => {
    const sourceShape = {
      agents: { entries: { main: { default: true, token: "${TOKEN}" } } },
    };
    const runtime = {
      agents: { entries: { main: { default: true, token: "resolved-token" } } },
    };
    const candidate = {
      agents: { entries: { primary: { default: true, token: "resolved-token" } } },
    };

    expect(
      projectRuntimeConfigOntoSourceSnapshot({
        sourceSnapshot: sourceShape as unknown as OpenClawConfig,
        runtimeSnapshot: runtime as unknown as OpenClawConfig,
        candidate: candidate as unknown as OpenClawConfig,
      }),
    ).toEqual({
      ok: true,
      value: {
        agents: { entries: { primary: { default: true, token: "${TOKEN}" } } },
      },
    });
  });

  it("projects a unique rename of a runtime-only map entry", () => {
    expect(
      projectRuntimeConfigOntoSourceSnapshot({
        sourceSnapshot: {},
        runtimeSnapshot: { agents: { entries: { main: { default: true } } } },
        candidate: { agents: { entries: { primary: { default: true } } } },
      }),
    ).toEqual({
      ok: true,
      value: { agents: { entries: { primary: { default: true } } } },
    });
  });

  it("rejects one-to-many map projection from one authored reference", () => {
    const entry = { token: "resolved-token" };
    expect(
      projectRuntimeConfigOntoSourceSnapshot({
        sourceSnapshot: { plugins: { entries: { old: { token: "${TOKEN}" } } } },
        runtimeSnapshot: { plugins: { entries: { old: entry } } },
        candidate: { plugins: { entries: { first: entry, second: entry } } },
      }),
    ).toEqual({
      ok: false,
      error: { code: "ambiguous-runtime-map", key: "plugins.entries" },
    });
  });

  it("rejects one-to-many map projection from one authored include", () => {
    const entry = { token: "resolved-token" };
    expect(
      projectRuntimeConfigOntoSourceSnapshot({
        sourceSnapshot: { plugins: { entries: { old: { $include: "./entry.json" } } } },
        runtimeSnapshot: { plugins: { entries: { old: entry } } },
        candidate: { plugins: { entries: { first: entry, second: entry } } },
      }),
    ).toEqual({
      ok: false,
      error: { code: "ambiguous-runtime-map", key: "plugins.entries" },
    });
  });

  it("rejects one-to-many map projection from an include-resolved source", () => {
    const entry = { token: "resolved-token" };
    expect(
      projectRuntimeConfigOntoSourceSnapshot({
        sourceSnapshot: { plugins: { $include: "./entries.json" } },
        runtimeSnapshot: { plugins: { a: entry } },
        candidate: { plugins: { a: entry, b: entry } },
      }),
    ).toEqual({
      ok: false,
      error: { code: "ambiguous-runtime-map", key: "plugins" },
    });
  });

  it("removes an authored model alias when its canonical runtime key is deleted", () => {
    expect(
      projectRuntimeConfigOntoSourceSnapshot({
        sourceSnapshot: {
          agents: {
            defaults: { models: { "google/gemini-3-pro-preview": { alias: "gemini" } } },
          },
        },
        runtimeSnapshot: {
          agents: {
            defaults: { models: { "google/gemini-3.1-pro-preview": { alias: "gemini" } } },
          },
        },
        candidate: { agents: { defaults: { models: {} } } },
      }),
    ).toEqual({ ok: true, value: { agents: { defaults: { models: {} } } } });
  });

  it("rejects touching a model entry with multiple normalized authored owners", () => {
    expect(
      projectRuntimeConfigOntoSourceSnapshot({
        sourceSnapshot: {
          agents: {
            defaults: {
              models: {
                "google/gemini-3-pro-preview": { params: { mode: "old" } },
                "google/gemini-3.1-pro-preview": { alias: "gemini" },
              },
            },
          },
        },
        runtimeSnapshot: {
          agents: {
            defaults: {
              models: {
                "google/gemini-3.1-pro-preview": {
                  alias: "gemini",
                  params: { mode: "old" },
                },
              },
            },
          },
        },
        candidate: { agents: { defaults: { models: {} } } },
      }),
    ).toEqual({
      ok: false,
      error: { code: "ambiguous-runtime-map", key: "agents.defaults.models" },
    });
  });

  it("rejects copying one existing map secret onto another key", () => {
    expect(
      projectRuntimeConfigOntoSourceSnapshot({
        sourceSnapshot: {
          plugins: { entries: { a: { token: "${A}" }, b: { token: "${B}" } } },
        },
        runtimeSnapshot: {
          plugins: { entries: { a: { token: "test-token-a" }, b: { token: "test-token-b" } } },
        },
        candidate: {
          plugins: { entries: { a: { token: "test-token-a" }, b: { token: "test-token-a" } } },
        },
      }),
    ).toEqual({
      ok: false,
      error: { code: "ambiguous-runtime-map", key: "plugins.entries" },
    });
  });

  it("rejects adding a map key from duplicate resolved authored references", () => {
    expect(
      projectRuntimeConfigOntoSourceSnapshot({
        sourceSnapshot: {
          plugins: { entries: { a: { token: "${A}" }, b: { token: "${B}" } } },
        },
        runtimeSnapshot: {
          plugins: { entries: { a: { token: "test-token" }, b: { token: "test-token" } } },
        },
        candidate: {
          plugins: {
            entries: {
              a: { token: "test-token" },
              b: { token: "test-token" },
              c: { token: "test-token" },
            },
          },
        },
      }),
    ).toEqual({
      ok: false,
      error: { code: "ambiguous-runtime-map", key: "plugins.entries" },
    });
  });

  it("preserves authored references when swapping existing map values", () => {
    expect(
      projectRuntimeConfigOntoSourceSnapshot({
        sourceSnapshot: {
          plugins: { entries: { a: { token: "${A}" }, b: { token: "${B}" } } },
        },
        runtimeSnapshot: {
          plugins: { entries: { a: { token: "test-token-a" }, b: { token: "test-token-b" } } },
        },
        candidate: {
          plugins: { entries: { a: { token: "test-token-b" }, b: { token: "test-token-a" } } },
        },
      }),
    ).toEqual({
      ok: true,
      value: { plugins: { entries: { a: { token: "${B}" }, b: { token: "${A}" } } } },
    });
  });

  it("allows a unique rename alongside an unrelated referenced deletion", () => {
    expect(
      projectRuntimeConfigOntoSourceSnapshot({
        sourceSnapshot: {
          plugins: {
            entries: { a: { mode: "one" }, c: { token: "${TOKEN}" } },
          },
        },
        runtimeSnapshot: {
          plugins: {
            entries: { a: { mode: "one" }, c: { token: "resolved-token" } },
          },
        },
        candidate: { plugins: { entries: { b: { mode: "one" } } } },
      }),
    ).toEqual({
      ok: true,
      value: { plugins: { entries: { b: { mode: "one" } } } },
    });
  });

  it("rejects a changed map-entry rename when authored references cannot be matched", () => {
    const sourceShape = {
      agents: { entries: { main: { default: true, token: "${TOKEN}" } } },
    };
    const runtime = {
      agents: { entries: { main: { default: true, token: "resolved-token" } } },
    };
    const candidate = {
      agents: { entries: { primary: { default: true, token: "changed-token" } } },
    };

    expect(
      projectRuntimeConfigOntoSourceSnapshot({
        sourceSnapshot: sourceShape as unknown as OpenClawConfig,
        runtimeSnapshot: runtime as unknown as OpenClawConfig,
        candidate: candidate as unknown as OpenClawConfig,
      }),
    ).toEqual({
      ok: false,
      error: { code: "ambiguous-runtime-map", key: "agents.entries" },
    });
  });

  it("rejects nested prototype-sensitive keys in a newly introduced subtree", () => {
    const candidate = JSON.parse(
      '{"plugins":{"entries":{"demo":{"config":{"__proto__":{"polluted":true}}}}}}',
    ) as OpenClawConfig;

    expect(
      projectRuntimeConfigOntoSourceSnapshot({
        sourceSnapshot: { plugins: { entries: {} } },
        runtimeSnapshot: { plugins: { entries: {} } },
        candidate,
      }),
    ).toEqual({
      ok: false,
      error: {
        code: "blocked-runtime-key",
        key: "plugins.entries.demo.config.__proto__",
      },
    });
  });
});
