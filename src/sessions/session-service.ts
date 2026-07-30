import { resolveSessionSelector } from "./session-resolve.js";
import type { SessionResolveInput, SessionServiceContract } from "./session-service-contract.js";

/** Canonical session orchestration shared by transport adapters. */
export class SessionService implements SessionServiceContract {
  async resolve(input: SessionResolveInput) {
    return await resolveSessionSelector(input);
  }
}
