/** Runtime type contracts for command-detection helpers loaded across lazy boundaries. */
import type { AforaConfig } from "../config/types.js";
import type { CommandNormalizeOptions } from "./commands-registry.types.js";

/** Runtime-injected predicate for deciding whether visible text is an Afora command. */
export type IsControlCommandMessage = (
  text?: string,
  cfg?: AforaConfig,
  options?: CommandNormalizeOptions,
) => boolean;

/** Runtime-injected predicate for deciding whether command authorization must be computed. */
export type ShouldComputeCommandAuthorized = (
  text?: string,
  cfg?: AforaConfig,
  options?: CommandNormalizeOptions,
) => boolean;
