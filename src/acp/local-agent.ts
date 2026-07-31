/** Thin ACP protocol adapter over the process-local session controller. */
import {
  PROTOCOL_VERSION,
  RequestError,
  type Agent,
  type AuthenticateRequest,
  type AuthenticateResponse,
  type CancelNotification,
  type CloseSessionRequest,
  type CloseSessionResponse,
  type InitializeRequest,
  type InitializeResponse,
  type ListSessionsRequest,
  type ListSessionsResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type ResumeSessionRequest,
  type ResumeSessionResponse,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type SetSessionModeRequest,
  type SetSessionModeResponse,
} from "@agentclientprotocol/sdk";
import type { AcpLocalSessionController } from "./local-session-controller.js";
import { ACP_LOCAL_AGENT_INFO } from "./types.js";

const ACP_MODEL_AUTH_METHOD = {
  id: "openclaw-model-setup",
  name: "Configure OpenClaw model",
  description: "Authenticate a model provider and choose the OpenClaw model defaults.",
  type: "terminal" as const,
  args: ["--configure-model"],
};

export class AcpLocalAgent implements Agent {
  private modelAuthAdvertised = false;

  constructor(private readonly controller: AcpLocalSessionController) {}

  async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
    this.modelAuthAdvertised = _params.clientCapabilities?.auth?.terminal === true;
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: {
          image: true,
          audio: false,
          embeddedContext: true,
        },
        mcpCapabilities: {
          http: false,
          sse: false,
        },
        sessionCapabilities: {
          list: {},
          resume: {},
          close: {},
        },
      },
      agentInfo: ACP_LOCAL_AGENT_INFO,
      authMethods: this.modelAuthAdvertised ? [ACP_MODEL_AUTH_METHOD] : [],
    };
  }

  async authenticate(params: AuthenticateRequest): Promise<AuthenticateResponse> {
    if (!this.modelAuthAdvertised || params.methodId !== ACP_MODEL_AUTH_METHOD.id) {
      throw RequestError.invalidParams(
        { methodId: params.methodId },
        `authentication method "${params.methodId}" was not advertised`,
      );
    }
    return {};
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    return await this.controller.newSession(params);
  }

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    return await this.controller.loadSession(params);
  }

  async listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
    return await this.controller.listSessions(params);
  }

  async resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse> {
    return await this.controller.resumeSession(params);
  }

  async closeSession(params: CloseSessionRequest): Promise<CloseSessionResponse> {
    return await this.controller.closeSession(params);
  }

  async setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse> {
    return await this.controller.setSessionMode(params);
  }

  async setSessionConfigOption(
    params: SetSessionConfigOptionRequest,
  ): Promise<SetSessionConfigOptionResponse> {
    return await this.controller.setSessionConfigOption(params);
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    return await this.controller.prompt(params);
  }

  async cancel(params: CancelNotification): Promise<void> {
    await this.controller.cancel(params);
  }

  shutdown(reason?: unknown): Promise<void> {
    return this.controller.shutdown(reason);
  }
}
