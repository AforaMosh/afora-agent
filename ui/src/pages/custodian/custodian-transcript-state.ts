import type { SystemAgentChatResult } from "@openclaw/gateway-protocol";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { WizardStep } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import {
  captureCustodianRecoveryScope,
  clearCustodianRecoveryForScope,
  type CustodianRecoveryScope,
  reconcileCustodianRecoveryForScope,
} from "./custodian-recovery.ts";
import { initialCustodianWizardValue } from "./custodian-wizard-step.ts";
import type { CustodianStructuredQuestion } from "./structured-question.ts";
import {
  createCustodianSessionId,
  loadCustodianTranscriptSnapshot,
  type CustodianMessage,
  type CustodianTranscriptSnapshot,
} from "./transcript.ts";

export type CustodianTranscriptHistoryOutcome = "recovered" | "inactive" | "unavailable";

type CustodianTranscriptTurnPosition = {
  globalIndex: number;
  sessionId?: string;
  sessionIndex: number;
};

/** Transcript-owned state shared by live turns and reload recovery. */
export abstract class CustodianTranscriptState {
  messages: CustodianMessage[] = [];
  sensitive = false;
  wizardInputPending = false;
  wizardValue: unknown;
  wizardSecretVisible = false;
  questionReplyUncertain = false;
  earlierBoundaryAfterId: number | null = null;
  activeClient: GatewayBrowserClient | null = null;

  protected sessionId = createCustodianSessionId();
  protected nextMessageId = 1;
  protected requestEpoch = 0;
  protected sessionClient: GatewayBrowserClient | null = null;
  protected transcriptSessionId: string | null = null;
  // Reconnect mutates the client's scope; cleanup must keep targeting the identity that wrote the handle.
  private sessionRecoveryScope: CustodianRecoveryScope | null = null;
  private lastHelloDeviceToken = "";

  protected abstract emit(): void;

  protected bindSessionRecovery(client: GatewayBrowserClient, gatewayUrl: string): void {
    this.sessionClient = client;
    this.sessionRecoveryScope = captureCustodianRecoveryScope(client, gatewayUrl);
  }

  protected captureTranscriptTurnPosition(sessionId?: string): CustodianTranscriptTurnPosition {
    // Recovery replaces global history with session-scoped rows. Retain both offsets so a
    // pending action reconciles with whichever authoritative transcript remains current.
    const globalIndex = this.messages.length;
    if (this.transcriptSessionId === sessionId) {
      return { globalIndex, sessionId, sessionIndex: globalIndex };
    }
    const boundaryIndex =
      this.earlierBoundaryAfterId === null
        ? -1
        : this.messages.findIndex((message) => message.id === this.earlierBoundaryAfterId);
    return { globalIndex, sessionId, sessionIndex: globalIndex - (boundaryIndex + 1) };
  }

  protected restoreUnacceptedTranscriptTurn(
    position: CustodianTranscriptTurnPosition,
    message: CustodianMessage,
  ): void {
    if (this.sessionId !== position.sessionId) {
      return;
    }
    const index =
      this.transcriptSessionId === position.sessionId
        ? position.sessionIndex
        : position.globalIndex;
    const existing = this.messages[index];
    if (existing && (existing.role === "user" || existing.structuredResponse !== null)) {
      return;
    }
    this.messages = this.messages.toSpliced(Math.min(index, this.messages.length), 0, message);
  }

  protected currentSessionOwnershipKey(context: ApplicationContext | null): string {
    if (!context) {
      return "";
    }
    const { gatewayUrl, token, password, bootstrapToken } = context.gateway.connection;
    const auth = context.gateway.snapshot.hello?.auth;
    if (auth) {
      this.lastHelloDeviceToken = auth.deviceToken ?? "";
    }
    const client = context.gateway.snapshot.client;
    const recoveryScope = client?.recoveryScopeReady
      ? (client.recoveryScope?.trim() ?? "")
      : (this.sessionRecoveryScope?.recoveryScope ?? "");
    if (recoveryScope) {
      // The Gateway derives this scope from the authenticated owner. Credential and
      // device-token rotation must not discard that owner's live setup session.
      return JSON.stringify([gatewayUrl, recoveryScope]);
    }
    return JSON.stringify([gatewayUrl, token, password, bootstrapToken, this.lastHelloDeviceToken]);
  }

  protected clearSessionRecovery(expectedSessionId = this.sessionId): void {
    if (!this.sessionRecoveryScope) {
      return;
    }
    clearCustodianRecoveryForScope(this.sessionRecoveryScope, expectedSessionId);
  }

  protected reconcileSessionRecovery(
    result: SystemAgentChatResult,
    requestSessionId: string,
  ): void {
    if (!this.sessionRecoveryScope) {
      return;
    }
    reconcileCustodianRecoveryForScope(this.sessionRecoveryScope, result, requestSessionId);
  }

  protected async refreshTranscriptHistory(
    client: GatewayBrowserClient,
    epoch: number,
    historySupported: boolean,
    sessionId?: string,
  ): Promise<CustodianTranscriptHistoryOutcome> {
    if (!historySupported) {
      return "inactive";
    }
    let transcript;
    try {
      transcript = await loadCustodianTranscriptSnapshot(client, this.nextMessageId, sessionId);
    } catch {
      return "unavailable";
    }
    if (epoch !== this.requestEpoch || client !== this.activeClient) {
      return "inactive";
    }
    const recovered = this.applyTranscriptSnapshot(transcript, sessionId);
    this.emit();
    return recovered ? "recovered" : "inactive";
  }

  protected appendAssistant(
    reply: string,
    question: CustodianStructuredQuestion | null,
    step: WizardStep | null,
  ): void {
    this.messages = [
      ...this.messages,
      {
        id: this.nextMessageId++,
        role: "assistant",
        text: reply,
        at: Date.now(),
        question,
        step,
        structuredResponse: null,
      },
    ];
  }

  protected applyTranscriptSnapshot(
    transcript: CustodianTranscriptSnapshot,
    recoveredSessionId?: string,
  ): boolean {
    this.messages = transcript.messages;
    this.transcriptSessionId = recoveredSessionId ?? null;
    this.nextMessageId = transcript.nextMessageId;
    this.earlierBoundaryAfterId = transcript.earlierBoundaryAfterId;
    const step = transcript.recoveredStep;
    if (recoveredSessionId) {
      this.sessionId = recoveredSessionId;
      this.sensitive = step?.sensitive === true;
      this.wizardInputPending = step !== undefined;
      this.wizardValue = step ? initialCustodianWizardValue(step) : undefined;
      this.wizardSecretVisible = false;
      this.questionReplyUncertain = false;
    }
    return step !== undefined;
  }
}
