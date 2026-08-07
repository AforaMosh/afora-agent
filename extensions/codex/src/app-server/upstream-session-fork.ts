import type {
  AgentHarnessSessionForkParams,
  AgentHarnessSessionForkResult,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import {
  deleteSessionUpstreamLink,
  upsertSessionUpstreamLink,
} from "openclaw/plugin-sdk/session-catalog";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { isIncognitoSessionKey } from "../incognito-session.js";
import type { CodexSessionCatalogControl } from "../session-catalog-types.js";
import { codexLastTerminalTurnId, codexUpstreamBaseline } from "../session-upstream-marker.js";
import { assertCodexThreadForkResponse } from "./protocol-validators.js";
import type { CodexThread, CodexThreadForkResponse } from "./protocol.js";
import { sessionBindingIdentity, type CodexAppServerBindingStore } from "./session-binding.js";
import { createImportedCodexSession } from "./session-history-import.js";
import { assertCodexArchiveDescendantsUnowned } from "./thread-archive-guard.js";
import { assertNoRetiredLegacyMcpThreadLineage } from "./thread-legacy-lineage.js";
import {
  listCodexUpstreamTurns,
  precheckCodexUpstreamForkBoundary,
  resolveCodexUpstreamForkBoundary,
} from "./upstream-fork-boundary.js";

type SessionUpstreamLinkIdentity = NonNullable<
  NonNullable<Parameters<typeof deleteSessionUpstreamLink>[2]>["expected"]
>;

function readConnectionFingerprint(ref: unknown): string | undefined {
  if (!isRecord(ref)) {
    return undefined;
  }
  return typeof ref.connectionFingerprint === "string" && ref.connectionFingerprint.trim()
    ? ref.connectionFingerprint
    : undefined;
}

function normalizeTurnId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export async function forkCodexUpstreamSession(
  params: AgentHarnessSessionForkParams,
  options: {
    bindingStore: CodexAppServerBindingStore;
    control: CodexSessionCatalogControl;
    harnessRuntimeId: string;
    resolveConfig?: () => OpenClawConfig | undefined;
    runtime: PluginRuntime;
  },
): Promise<AgentHarnessSessionForkResult> {
  try {
    return await options.control.withPinnedConnection(async (control) => {
      const incognito = isIncognitoSessionKey(params.targetKey);
      const clientId = control.clientId?.trim();
      if (incognito && !clientId) {
        throw new Error("Incognito Codex forks require the live pinned app-server client");
      }
      let linked = false;
      let linkedIdentity: SessionUpstreamLinkIdentity | undefined;
      let bindingIdentity: ReturnType<typeof sessionBindingIdentity> | undefined;
      const compensateFork = async (forkedThreadId: string) => {
        await options.bindingStore.withThreadArchiveFence(async () => {
          if (bindingIdentity) {
            await options.bindingStore
              .mutate(bindingIdentity, { kind: "clear", threadId: forkedThreadId })
              .catch(() => undefined);
            let targetBinding;
            try {
              targetBinding = await options.bindingStore.read(bindingIdentity);
            } catch {
              return;
            }
            if (targetBinding?.threadId === forkedThreadId) {
              return;
            }
          }
          let ownership: Awaited<ReturnType<CodexAppServerBindingStore["inspectThreadOwnership"]>>;
          try {
            ownership = await options.bindingStore.inspectThreadOwnership(forkedThreadId);
          } catch {
            return;
          }
          if (!ownership.hasUnexpectedOwner) {
            try {
              await assertCodexArchiveDescendantsUnowned({
                bindingStore: options.bindingStore,
                threadId: forkedThreadId,
                listPage: (request) => control.listDescendantPage(request),
                rejectAnyDescendant: true,
                assertDescendantIdle: async (descendantThreadId) => {
                  const descendant = await control.readThread(descendantThreadId, false);
                  const status = descendant.status?.type;
                  if (
                    descendant.id !== descendantThreadId ||
                    (status !== "idle" && status !== "notLoaded")
                  ) {
                    throw new Error(
                      `Codex fork descendant is not safely idle: ${descendantThreadId}`,
                    );
                  }
                },
              });
            } catch {
              return;
            }
            if (linked) {
              if (!linkedIdentity) {
                return;
              }
              deleteSessionUpstreamLink(params.targetKey, params.source.agentId, {
                expected: linkedIdentity,
              });
            }
            await control.archiveThread(forkedThreadId).catch(() => undefined);
          }
        });
      };
      const sourceFingerprint = readConnectionFingerprint(params.upstream.ref);
      const config = options.resolveConfig?.() ?? {};
      const sourceIdentity = sessionBindingIdentity({
        agentId: params.source.agentId,
        sessionId: params.source.sessionId,
        sessionKey: params.source.sessionKey,
        config,
      });
      if (
        params.upstream.kind !== "codex-app-server" ||
        !sourceFingerprint ||
        sourceFingerprint !== control.connectionFingerprint
      ) {
        return {
          status: "failed",
          code: "upstream-unavailable",
          message:
            "This Codex thread is not available on the current connection. Reconnect to its host and try again.",
        };
      }
      const resolved = await resolveCodexUpstreamForkBoundary({
        ...params.source,
        threadId: params.upstream.threadId,
        control,
      });
      if (!resolved.ok) {
        return { status: "failed", code: resolved.code, message: resolved.message };
      }
      const liveTurns = await listCodexUpstreamTurns(control, params.upstream.threadId);
      const precheck = precheckCodexUpstreamForkBoundary({
        boundary: resolved.boundary,
        turns: liveTurns,
      });
      if (!precheck.ok) {
        return { status: "failed", code: precheck.code, message: precheck.message };
      }
      // beforeTurnId is experimental; the initialized shared client explicitly negotiates it.
      const rawResponse = await options.bindingStore.withThreadArchiveFence(async () => {
        const ownership = await options.bindingStore.inspectThreadOwnership(
          params.upstream.threadId,
          [sourceIdentity],
        );
        if (ownership.hasUnexpectedOwner) {
          throw new Error("Codex upstream thread is already bound to an OpenClaw session");
        }
        if (ownership.hasLegacyNativeMcpOwner) {
          throw new Error(
            "The Codex upstream thread must complete its configured MCP upgrade before it can be forked.",
          );
        }
        const sourceThread = await control.readThread(params.upstream.threadId, false);
        await assertNoRetiredLegacyMcpThreadLineage({
          bindingStore: options.bindingStore,
          threadId: params.upstream.threadId,
          initialThread: sourceThread,
          readThread: async (threadId) => await control.readThread(threadId, false),
        });
        return await control.forkThread({
          threadId: params.upstream.threadId,
          beforeTurnId: resolved.boundary.beforeTurnId,
          ...(incognito ? { ephemeral: true } : {}),
          excludeTurns: !incognito,
        });
      });
      // An invalid response cannot prove that its claimed id belongs to the new fork.
      // Preserve an orphan rather than deleting an unrelated native thread.
      const response: CodexThreadForkResponse = assertCodexThreadForkResponse(rawResponse);
      const threadId = response.thread.id.trim();
      if (!threadId) {
        throw new Error("Codex thread/fork response did not include a thread id");
      }
      // A contract-violating response reusing the source id would bind (and later
      // archive) the original conversation; reject identity reuse outright.
      if (threadId === params.upstream.threadId) {
        throw new Error("Codex thread/fork response reused the source thread id");
      }
      const forkedThreadId = threadId;
      try {
        const connectionFingerprint = control.connectionFingerprint;
        if (!connectionFingerprint) {
          throw new Error("Codex fork connection did not include a fingerprint");
        }
        const forkedTurns = incognito
          ? (response.thread.turns ?? [])
          : await listCodexUpstreamTurns(control, threadId);
        const expectedLastTurnId = resolved.boundary.retainedMarker.turnId;
        const actualLastTurnId = forkedTurns.at(-1)?.id ?? null;
        // Boundary resolution already verified the source prefix; this read-back tail identity
        // detects app-server versions that ignored the exclusive beforeTurnId cut.
        if (actualLastTurnId !== expectedLastTurnId) {
          await compensateFork(forkedThreadId);
          return {
            status: "failed",
            code: "upstream-unavailable",
            message:
              "This Codex version does not support message-level forks. Update Codex, reconnect, and try again.",
          };
        }
        const forkedThread: CodexThread = { ...response.thread, turns: forkedTurns };
        const throughTurnId = codexLastTerminalTurnId(forkedThread, normalizeTurnId) ?? null;
        const marker = codexUpstreamBaseline(forkedThread, normalizeTurnId);
        const created = await createImportedCodexSession({
          runtime: options.runtime,
          config,
          key: params.targetKey,
          agentId: params.source.agentId,
          thread: forkedThread,
          throughTurnId,
          initialEntry: {
            agentHarnessId: options.harnessRuntimeId,
            modelSelectionLocked: true,
          },
          afterImport: async (entry) => {
            bindingIdentity = sessionBindingIdentity({
              agentId: entry.agentId,
              sessionId: entry.sessionId,
              sessionKey: entry.key,
              config,
            });
            await options.bindingStore.withThreadArchiveFence(async () => {
              const ownership = await options.bindingStore.inspectThreadOwnership(threadId, [
                bindingIdentity!,
              ]);
              if (ownership.hasUnexpectedOwner) {
                throw new Error("Codex fork was claimed by another OpenClaw session");
              }
              // Link BEFORE bind: a crash cannot expose a bound session to local-only
              // rewind/switch while its canonical upstream ownership is missing.
              linkedIdentity = {
                catalogId: params.upstream.catalogId,
                hostId: params.upstream.hostId,
                threadId,
                upstreamKind: params.upstream.kind,
                upstreamRef: { connectionFingerprint, threadId },
              };
              linked = upsertSessionUpstreamLink({
                sessionKey: entry.key,
                agentId: entry.agentId,
                ...linkedIdentity,
                marker,
              });
              if (!linked) {
                throw new Error("Codex fork link could not be persisted");
              }
              const attached = await options.bindingStore.mutate(bindingIdentity!, {
                kind: "set",
                binding: {
                  threadId,
                  ...(incognito && clientId ? { clientId } : {}),
                  cwd: forkedThread.cwd ?? "",
                  model: response.model,
                  modelProvider: response.modelProvider ?? undefined,
                  historyCoveredThrough: new Date().toISOString(),
                },
              });
              if (!attached) {
                throw new Error("Codex session binding changed before the fork could be attached");
              }
            });
            return { pluginExtensions: entry.entry.pluginExtensions };
          },
        });
        return {
          status: "created",
          key: created.key,
          ...(resolved.editorText !== undefined ? { editorText: resolved.editorText } : {}),
        };
      } catch {
        // thread/fork commits before local materialization. The guarded session initializer
        // rolls back its row/transcript; this capability clears link/binding and archives the orphan.
        await compensateFork(forkedThreadId);
        return {
          status: "failed",
          code: "upstream-unavailable",
          message:
            "The Codex fork could not be verified or imported into a new session. Refresh sessions and try again.",
        };
      }
    });
  } catch {
    return {
      status: "failed",
      code: "upstream-unavailable",
      message:
        "The Codex thread could not be forked. Check that Codex is available, then try again.",
    };
  }
}
