import type {
  ComputerActV2Request,
  ComputerActV2Result,
  ComputerUseCapabilities,
} from "./computer-use.js";

// Portable examples for TS consumers and generated native-protocol fixture readers.
/** Existing v1 action names remain generic node payload data, not a v2 declaration. */
export const COMPUTER_ACT_V1_ACTION_FIXTURES = [
  "screenshot",
  "left_click",
  "right_click",
  "middle_click",
  "double_click",
  "triple_click",
  "mouse_move",
  "left_click_drag",
  "left_mouse_down",
  "left_mouse_up",
  "scroll",
  "type",
  "key",
  "hold_key",
  "wait",
] as const;

export const COMPUTER_USE_V2_CAPABILITIES_FIXTURE: ComputerUseCapabilities = {
  contractVersion: 2,
  provider: { id: "fixture-provider", label: "Fixture Provider", generation: "generation-1" },
  readiness: { state: "ready" },
  actions: ["left_click", "get_window_state", "browser_type"],
  targets: ["screen", "window", "element", "browser"],
  deliveryModes: ["background", "foreground"],
  observations: ["image", "accessibility", "browser"],
  features: { multiDisplay: true },
};

export const COMPUTER_ACT_V2_REQUEST_FIXTURE: ComputerActV2Request = {
  version: 2,
  providerGeneration: "generation-1",
  executionId: "execution-1",
  action: {
    name: "left_click",
    target: { kind: "screen", screenIndex: 0, frameId: "frame-1", point: { x: 24, y: 48 } },
  },
};

export const COMPUTER_ACT_V2_RESULT_FIXTURE: ComputerActV2Result = {
  ok: true,
  provider: { id: "fixture-provider", generation: "generation-1" },
  effect: "confirmed",
  verified: true,
  observation: {
    observationId: "observation-1",
    kind: "accessibility",
    target: { kind: "window", windowRef: "window-1", observationId: "observation-1" },
    resourceRefs: ["resource-1"],
    elements: [
      {
        elementRef: "element-1",
        role: "button",
        label: "Save",
        bounds: { x: 24, y: 48, width: 80, height: 32 },
        supportedActions: ["left_click"],
      },
    ],
  },
  resources: [{ kind: "image", resourceRef: "resource-1", mimeType: "image/png" }],
};
