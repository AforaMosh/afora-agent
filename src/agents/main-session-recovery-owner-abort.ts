import type { InternalSessionEntry as SessionEntry } from "../config/sessions.js";
import { applySessionEntryReplacements } from "../config/sessions/session-accessor.js";
import {
  abortMainSessionRecoveryOwnerEntry,
  ownsMainSessionRecoveryForegroundClaim,
} from "./main-session-recovery-owner-abort-entry.js";
import type { MainSessionRecoveryOwnerLease } from "./main-session-recovery-store.js";

type MainSessionRecoveryOwnerAbortResult =
  | { kind: "applied"; entry: SessionEntry; sessionKey: string }
  | { kind: "owner_changed" };

export async function abortMainSessionRecoveryOwner(
  lease: MainSessionRecoveryOwnerLease,
  runId?: string,
): Promise<MainSessionRecoveryOwnerAbortResult> {
  return await applySessionEntryReplacements<MainSessionRecoveryOwnerAbortResult>({
    requireWriteSuccess: true,
    storePath: lease.storePath,
    update: (entries) => {
      const selected = entries.find(({ sessionKey }) => sessionKey === lease.sessionKey);
      const candidate =
        entries.find(({ entry }) =>
          ownsMainSessionRecoveryForegroundClaim(entry as SessionEntry, lease),
        ) ?? selected;
      const entry = candidate?.entry as SessionEntry | undefined;
      if (
        !candidate ||
        !entry ||
        !abortMainSessionRecoveryOwnerEntry({
          claim: lease,
          entry,
          now: Date.now(),
          runId,
        })
      ) {
        return { result: { kind: "owner_changed" } };
      }
      return {
        result: { kind: "applied", entry, sessionKey: candidate.sessionKey },
        replacements: [{ sessionKey: candidate.sessionKey, entry }],
      };
    },
  });
}
