import { describe, expect, it } from "vitest";
import {
  validateComputerActV2Request,
  validateComputerActV2Result,
  validateComputerUseCapabilities,
  validateConnectParams,
  validateNodeInvokeParams,
} from "../index.js";
import {
  COMPUTER_ACT_V1_ACTION_FIXTURES,
  COMPUTER_ACT_V2_REQUEST_FIXTURE,
  COMPUTER_ACT_V2_RESULT_FIXTURE,
  COMPUTER_USE_V2_CAPABILITIES_FIXTURE,
} from "./computer-use.fixtures.js";

const provider = { id: "fixture-provider", generation: "generation-1" };
const screen = { kind: "screen", screenIndex: 0, frameId: "frame-1", point: { x: 1, y: 2 } };
const windowTarget = { kind: "window", windowRef: "window-1", observationId: "observation-1" };
const browser = {
  kind: "browser",
  browserRef: "browser-1",
  pageRef: "page-1",
  observationId: "observation-1",
};
const browserElement = {
  ...browser,
  elementRef: "element-1",
};

function request(action: Record<string, unknown>) {
  return { version: 2, providerGeneration: "generation-1", executionId: "execution-1", action };
}

describe("Computer Use v2 protocol", () => {
  it("accepts the additive capability declaration and every readiness branch", () => {
    expect(validateComputerUseCapabilities(COMPUTER_USE_V2_CAPABILITIES_FIXTURE)).toBe(true);
    for (const readiness of [
      { state: "ready" },
      { state: "disabled" },
      { state: "missing-provider" },
      { state: "starting" },
      { state: "incompatible-provider", reasonCode: "version-skew" },
      { state: "missing-permission", reasonCode: "accessibility" },
      { state: "backend-unavailable", reasonCode: "wayland" },
      { state: "failed", reasonCode: "startup-failed" },
    ]) {
      expect(
        validateComputerUseCapabilities({ ...COMPUTER_USE_V2_CAPABILITIES_FIXTURE, readiness }),
      ).toBe(true);
    }
  });

  it("rejects unknown or open v2 capability values", () => {
    expect(
      validateComputerUseCapabilities({
        ...COMPUTER_USE_V2_CAPABILITIES_FIXTURE,
        readiness: { state: "degraded" },
      }),
    ).toBe(false);
    expect(
      validateComputerUseCapabilities({
        ...COMPUTER_USE_V2_CAPABILITIES_FIXTURE,
        actions: ["provider.native.call"],
      }),
    ).toBe(false);
    expect(
      validateComputerUseCapabilities({ ...COMPUTER_USE_V2_CAPABILITIES_FIXTURE, extra: true }),
    ).toBe(false);
  });

  it("accepts every retained typed action with its semantic target", () => {
    const actions = [
      ...[
        "left_click",
        "right_click",
        "middle_click",
        "double_click",
        "triple_click",
        "mouse_move",
        "left_mouse_down",
        "left_mouse_up",
      ].map((name) => ({ name, target: screen, deliveryMode: "background" })),
      { name: "left_click_drag", target: screen, from: { x: 0, y: 0 } },
      { name: "scroll", target: screen, direction: "down", amount: 3 },
      { name: "type", target: windowTarget, text: "hello" },
      { name: "key", target: windowTarget, keys: "ctrl+l" },
      { name: "hold_key", target: windowTarget, keys: "shift", durationMs: 100 },
      {
        name: "set_value",
        target: {
          kind: "element",
          windowRef: "window-1",
          elementRef: "element-1",
          observationId: "observation-1",
        },
        value: "hello",
      },
      { name: "zoom", target: screen, direction: "in" },
      { name: "screenshot", screenIndex: 0 },
      { name: "list_apps" },
      { name: "list_windows" },
      { name: "get_accessibility_tree" },
      { name: "get_cursor_position" },
      { name: "get_window_state", target: windowTarget },
      { name: "get_browser_state", target: browser },
      { name: "launch_app", appRef: "app-1" },
      { name: "kill_app", appRef: "app-1" },
      { name: "bring_to_front", appRef: "app-1" },
      { name: "browser_navigate", target: browser, url: "https://example.test" },
      { name: "browser_click", target: browserElement, deliveryMode: "background" },
      { name: "browser_type", target: browserElement, text: "hello" },
      { name: "browser_dialog", target: browser, accept: true },
      {
        name: "browser_set_input_files",
        target: browserElement,
        resourceRefs: ["resource-1"],
      },
      { name: "browser_download", target: browser },
      { name: "browser_pointer", target: browser, point: { x: 1, y: 2 } },
      { name: "wait", durationMs: 0 },
    ];
    for (const action of actions) {
      expect(validateComputerActV2Request(request(action))).toBe(true);
    }
  });

  it("rejects unknown, deferred, or semantically incomplete v2 actions", () => {
    expect(validateComputerActV2Request(COMPUTER_ACT_V2_REQUEST_FIXTURE)).toBe(true);
    expect(validateComputerActV2Request({ ...COMPUTER_ACT_V2_REQUEST_FIXTURE, version: 3 })).toBe(
      false,
    );
    expect(validateComputerActV2Request(request({ name: "provider.native.call" }))).toBe(false);
    expect(
      validateComputerActV2Request(request({ name: "browser_prepare", target: browser })),
    ).toBe(false);
    expect(
      validateComputerActV2Request(request({ name: "replay_trajectory", resourceRef: "r-1" })),
    ).toBe(false);
    expect(
      validateComputerActV2Request(
        request({ name: "left_click", target: { ...screen, kind: "desktop" } }),
      ),
    ).toBe(false);
    expect(
      validateComputerActV2Request(
        request({ name: "left_click", target: screen, nativeArguments: {} }),
      ),
    ).toBe(false);
    expect(
      validateComputerActV2Request(
        request({
          name: "left_click",
          target: { kind: "window", windowRef: "window-1", point: { x: 1, y: 2 } },
        }),
      ),
    ).toBe(false);
    expect(
      validateComputerActV2Request(
        request({ name: "left_click", target: { kind: "window", windowRef: "window-1" } }),
      ),
    ).toBe(false);
    expect(
      validateComputerActV2Request(
        request({
          name: "browser_click",
          target: { kind: "browser", browserRef: "browser-1", elementRef: "element-1" },
        }),
      ),
    ).toBe(false);
    expect(
      validateComputerActV2Request(
        request({ name: "set_value", target: windowTarget, value: "x" }),
      ),
    ).toBe(false);
  });

  it("keeps references opaque and returns bounded semantic observations and closed results", () => {
    const opaque = "not-a-provider-id:/tmp/window-42";
    const opaqueRequest = request({
      name: "left_click",
      target: { kind: "screen", screenIndex: 0, frameId: opaque, point: { x: 2, y: 3 } },
    });
    expect(validateComputerActV2Request(opaqueRequest)).toBe(true);
    expect(opaqueRequest.action.target.frameId).toBe(opaque);

    expect(validateComputerActV2Result(COMPUTER_ACT_V2_RESULT_FIXTURE)).toBe(true);
    expect(
      validateComputerActV2Result({
        ...COMPUTER_ACT_V2_RESULT_FIXTURE,
        observation: {
          ...COMPUTER_ACT_V2_RESULT_FIXTURE.observation,
          elements: [
            {
              elementRef: "element-2",
              role: "textbox",
              label: "Name",
              value: "Ada",
              bounds: { x: 1, y: 2, width: 3, height: 4 },
              supportedActions: ["set_value", "type"],
            },
          ],
        },
      }),
    ).toBe(true);
    expect(
      validateComputerActV2Result({
        ...COMPUTER_ACT_V2_RESULT_FIXTURE,
        observation: {
          ...COMPUTER_ACT_V2_RESULT_FIXTURE.observation,
          elements: [
            {
              elementRef: "element-2",
              role: "button",
              bounds: { x: 1, y: 2, width: 3, height: 4 },
              supportedActions: ["provider.native.call"],
            },
          ],
        },
      }),
    ).toBe(false);
    for (const code of [
      "COMPUTER_STALE_PROVIDER",
      "COMPUTER_STALE_EXECUTION",
      "COMPUTER_STALE_FRAME",
      "COMPUTER_STALE_OBSERVATION",
      "COMPUTER_STALE_ELEMENT",
      "COMPUTER_STALE_BROWSER",
      "COMPUTER_UNSUPPORTED_ACTION",
      "COMPUTER_UNSUPPORTED_DELIVERY",
      "COMPUTER_HOST_BUSY",
      "COMPUTER_MISSING_PERMISSION",
      "COMPUTER_BACKEND_UNAVAILABLE",
    ]) {
      expect(
        validateComputerActV2Result({
          ok: false,
          provider,
          error: { code, reasonCode: "fixture" },
        }),
      ).toBe(true);
    }
    for (const effect of ["confirmed", "unverifiable", "suspected_noop"]) {
      expect(
        validateComputerActV2Result({
          ok: true,
          provider,
          effect,
          escalation: { recommended: "foreground", reasonCode: "fixture" },
        }),
      ).toBe(true);
    }
    expect(
      validateComputerActV2Result({ ok: false, provider, error: { code: "COMPUTER_UNKNOWN" } }),
    ).toBe(false);
    expect(
      validateComputerActV2Result({ ok: true, provider, error: { code: "COMPUTER_HOST_BUSY" } }),
    ).toBe(false);
    expect(
      validateComputerActV2Result({ ...COMPUTER_ACT_V2_RESULT_FIXTURE, path: "cuA-only" }),
    ).toBe(false);
  });

  it("leaves v1 generic node payloads unchanged and does not infer a v2 capability", () => {
    for (const action of COMPUTER_ACT_V1_ACTION_FIXTURES) {
      expect(
        validateConnectParams({
          minProtocol: 3,
          maxProtocol: 4,
          client: { id: "node-host", version: "1.0.0", platform: "test", mode: "node" },
          commands: ["screen.snapshot", "computer.act"],
        }),
      ).toBe(true);
      expect(
        validateNodeInvokeParams({
          nodeId: "node-1",
          command: "computer.act",
          idempotencyKey: "v1-action-1",
          params: { action },
        }),
      ).toBe(true);
    }
    expect(
      validateConnectParams({
        minProtocol: 3,
        maxProtocol: 4,
        client: { id: "node-host", version: "1.0.0", platform: "test", mode: "node" },
        commands: ["screen.snapshot", "computer.act"],
      }),
    ).toBe(true);
    expect(
      validateConnectParams({
        minProtocol: 3,
        maxProtocol: 4,
        client: { id: "node-host", version: "1.0.0", platform: "test", mode: "node" },
        commands: ["screen.snapshot", "computer.act"],
        computerUse: COMPUTER_USE_V2_CAPABILITIES_FIXTURE,
      }),
    ).toBe(true);
  });
});
