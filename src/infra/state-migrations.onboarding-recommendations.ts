import { existsSync } from "node:fs";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { resolveWorkspaceStateIdentity } from "../agents/workspace-state-store.js";
import type { AforaConfig } from "../config/config.js";
import { tryResolveLegacyCompatibilityAgentId } from "../config/legacy.default-agent-owner.js";
import type { DB as AforaStateKyselyDatabase } from "../state/afora-state-db.generated.js";
import { runAforaStateWriteTransaction } from "../state/afora-state-db.js";
import { resolveAforaStateSqlitePath } from "../state/afora-state-db.paths.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import type { MigrationMessages } from "./state-migrations.types.js";

const LEGACY_ONBOARDING_RECOMMENDATIONS_KEY = "primary";

type OnboardingRecommendationsMigrationDatabase = Pick<
  AforaStateKyselyDatabase,
  "onboarding_recommendations"
>;

/** Move the shipped singleton row into the default workspace during doctor repair. */
export function migrateLegacyOnboardingRecommendationsScope(params: {
  cfg: AforaConfig;
  env?: NodeJS.ProcessEnv;
}): MigrationMessages {
  const env = params.env ?? process.env;
  if (!existsSync(resolveAforaStateSqlitePath(env))) {
    return { changes: [], warnings: [] };
  }

  try {
    const migrationAgentId = tryResolveLegacyCompatibilityAgentId(params.cfg);
    const workspaceKey = migrationAgentId
      ? resolveWorkspaceStateIdentity(resolveAgentWorkspaceDir(params.cfg, migrationAgentId, env))
          .workspaceKey
      : undefined;
    const outcome = runAforaStateWriteTransaction(
      ({ db: writeDatabase }) => {
        const writeDb =
          getNodeSqliteKysely<OnboardingRecommendationsMigrationDatabase>(writeDatabase);
        const legacyAtCommit = executeSqliteQueryTakeFirstSync(
          writeDatabase,
          writeDb
            .selectFrom("onboarding_recommendations")
            .select("config_key")
            .where("config_key", "=", LEGACY_ONBOARDING_RECOMMENDATIONS_KEY),
        );
        if (!legacyAtCommit) {
          return "unchanged" as const;
        }
        if (!workspaceKey) {
          return "deferred" as const;
        }
        const scoped = executeSqliteQueryTakeFirstSync(
          writeDatabase,
          writeDb
            .selectFrom("onboarding_recommendations")
            .select("config_key")
            .where("config_key", "=", workspaceKey),
        );
        if (scoped) {
          executeSqliteQuerySync(
            writeDatabase,
            writeDb
              .deleteFrom("onboarding_recommendations")
              .where("config_key", "=", LEGACY_ONBOARDING_RECOMMENDATIONS_KEY),
          );
          return "removed-legacy" as const;
        }
        executeSqliteQuerySync(
          writeDatabase,
          writeDb
            .updateTable("onboarding_recommendations")
            .set({ config_key: workspaceKey })
            .where("config_key", "=", LEGACY_ONBOARDING_RECOMMENDATIONS_KEY),
        );
        return "migrated" as const;
      },
      { env },
      { operationLabel: "onboarding.recommendations.migrate-scope" },
    );

    if (outcome === "migrated") {
      return {
        changes: ["Migrated onboarding recommendation state to the legacy owner workspace scope."],
        warnings: [],
      };
    }
    if (outcome === "removed-legacy") {
      return {
        changes: [
          "Removed ambiguous legacy onboarding recommendation state; kept the legacy owner workspace record.",
        ],
        warnings: [],
      };
    }
    if (outcome === "deferred") {
      return {
        changes: [],
        warnings: ["Deferred legacy onboarding recommendation migration: no owner is selected"],
      };
    }
    return { changes: [], warnings: [] };
  } catch (err) {
    return {
      changes: [],
      warnings: [`Failed migrating onboarding recommendation workspace scope: ${String(err)}`],
    };
  }
}
