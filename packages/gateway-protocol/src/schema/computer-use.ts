// Versioned, provider-neutral Computer Use schemas. V1 remains the generic
// node.invoke payload; this owner defines the additive closed v2 contract.
import { type Static, Type } from "typebox";
import { closedObject } from "./closed-object.js";

const OpaqueComputerReferenceValueSchema = Type.String({ minLength: 1, maxLength: 1024 });
const ComputerProviderIdSchema = Type.String({ minLength: 1, maxLength: 128 });
const ComputerProviderLabelSchema = Type.String({ minLength: 1, maxLength: 256 });
const ComputerProviderGenerationSchema = Type.String({ minLength: 1, maxLength: 256 });
const ComputerReasonCodeSchema = Type.String({ minLength: 1, maxLength: 128 });
const ComputerTextSchema = Type.String({ minLength: 1, maxLength: 65_536 });
const ComputerElementTextSchema = Type.String({ minLength: 1, maxLength: 4_096 });
const ComputerPointSchema = closedObject({
  x: Type.Number({ minimum: 0 }),
  y: Type.Number({ minimum: 0 }),
});
const ComputerBoundsSchema = closedObject({
  x: Type.Number({ minimum: 0 }),
  y: Type.Number({ minimum: 0 }),
  width: Type.Number({ minimum: 0 }),
  height: Type.Number({ minimum: 0 }),
});

// Matches the closed literals in ComputerActionNameSchema below.
const COMPUTER_ACTION_MAX_ITEMS = 33;

/** Model-visible v2 action names. Unsupported names are omitted from capabilities. */
export const ComputerActionNameSchema = Type.Union([
  Type.Literal("screenshot"),
  Type.Literal("left_click"),
  Type.Literal("right_click"),
  Type.Literal("middle_click"),
  Type.Literal("double_click"),
  Type.Literal("triple_click"),
  Type.Literal("mouse_move"),
  Type.Literal("left_click_drag"),
  Type.Literal("left_mouse_down"),
  Type.Literal("left_mouse_up"),
  Type.Literal("scroll"),
  Type.Literal("type"),
  Type.Literal("key"),
  Type.Literal("hold_key"),
  Type.Literal("wait"),
  Type.Literal("list_apps"),
  Type.Literal("list_windows"),
  Type.Literal("get_accessibility_tree"),
  Type.Literal("get_cursor_position"),
  Type.Literal("get_window_state"),
  Type.Literal("launch_app"),
  Type.Literal("kill_app"),
  Type.Literal("bring_to_front"),
  Type.Literal("set_value"),
  Type.Literal("zoom"),
  Type.Literal("get_browser_state"),
  Type.Literal("browser_navigate"),
  Type.Literal("browser_click"),
  Type.Literal("browser_type"),
  Type.Literal("browser_dialog"),
  Type.Literal("browser_set_input_files"),
  Type.Literal("browser_download"),
  Type.Literal("browser_pointer"),
]);

export const ComputerTargetClassSchema = Type.Union([
  Type.Literal("screen"),
  Type.Literal("window"),
  Type.Literal("element"),
  Type.Literal("browser"),
]);
export const ComputerDeliveryModeSchema = Type.Union([
  Type.Literal("background"),
  Type.Literal("foreground"),
]);
export const ComputerObservationClassSchema = Type.Union([
  Type.Literal("image"),
  Type.Literal("accessibility"),
  Type.Literal("browser"),
]);

const ComputerReadyReadinessSchema = closedObject({ state: Type.Literal("ready") });
const ComputerSimpleReadinessSchema = Type.Union([
  closedObject({ state: Type.Literal("disabled") }),
  closedObject({ state: Type.Literal("missing-provider") }),
  closedObject({ state: Type.Literal("starting") }),
]);
const ComputerReasonedReadinessSchema = Type.Union([
  closedObject({
    state: Type.Literal("incompatible-provider"),
    reasonCode: ComputerReasonCodeSchema,
  }),
  closedObject({ state: Type.Literal("missing-permission"), reasonCode: ComputerReasonCodeSchema }),
  closedObject({
    state: Type.Literal("backend-unavailable"),
    reasonCode: ComputerReasonCodeSchema,
  }),
  closedObject({ state: Type.Literal("failed"), reasonCode: ComputerReasonCodeSchema }),
]);

/** Provider readiness is descriptive only; arming remains a Gateway/node policy decision. */
export const ComputerUseReadinessSchema = Type.Union([
  ComputerReadyReadinessSchema,
  ComputerSimpleReadinessSchema,
  ComputerReasonedReadinessSchema,
]);

/** Bounded v2 capability declaration published by a node's active Computer Use provider. */
export const ComputerUseCapabilitiesSchema = closedObject({
  contractVersion: Type.Literal(2),
  provider: closedObject({
    id: ComputerProviderIdSchema,
    label: ComputerProviderLabelSchema,
    generation: ComputerProviderGenerationSchema,
  }),
  readiness: ComputerUseReadinessSchema,
  actions: Type.Array(ComputerActionNameSchema, { maxItems: COMPUTER_ACTION_MAX_ITEMS }),
  targets: Type.Array(ComputerTargetClassSchema, { maxItems: 4 }),
  deliveryModes: Type.Array(ComputerDeliveryModeSchema, { maxItems: 2 }),
  observations: Type.Array(ComputerObservationClassSchema, { maxItems: 3 }),
  features: closedObject({
    multiDisplay: Type.Boolean(),
  }),
});

/** Opaque public reference; adapters alone resolve their native identifiers. */
export const OpaqueComputerReferenceSchema = OpaqueComputerReferenceValueSchema;

export const ComputerScreenTargetSchema = closedObject({
  kind: Type.Literal("screen"),
  screenIndex: Type.Integer({ minimum: 0 }),
  frameId: OpaqueComputerReferenceSchema,
  point: Type.Optional(ComputerPointSchema),
});
const ComputerScreenPointTargetSchema = closedObject({
  kind: Type.Literal("screen"),
  screenIndex: Type.Integer({ minimum: 0 }),
  frameId: OpaqueComputerReferenceSchema,
  point: ComputerPointSchema,
});
const ComputerWindowIdentityTargetSchema = closedObject({
  kind: Type.Literal("window"),
  windowRef: OpaqueComputerReferenceSchema,
  observationId: Type.Optional(OpaqueComputerReferenceSchema),
});
const ComputerWindowPointTargetSchema = closedObject({
  kind: Type.Literal("window"),
  windowRef: OpaqueComputerReferenceSchema,
  // Window-local pixels are valid only for the exact observation that produced them.
  observationId: OpaqueComputerReferenceSchema,
  point: ComputerPointSchema,
});
export const ComputerWindowTargetSchema = Type.Union([
  ComputerWindowIdentityTargetSchema,
  ComputerWindowPointTargetSchema,
]);
export const ComputerElementTargetSchema = closedObject({
  kind: Type.Literal("element"),
  windowRef: OpaqueComputerReferenceSchema,
  elementRef: OpaqueComputerReferenceSchema,
  observationId: OpaqueComputerReferenceSchema,
});
const ComputerBrowserPageTargetSchema = closedObject({
  kind: Type.Literal("browser"),
  browserRef: OpaqueComputerReferenceSchema,
  pageRef: Type.Optional(OpaqueComputerReferenceSchema),
  observationId: Type.Optional(OpaqueComputerReferenceSchema),
});
const ComputerBrowserObservationTargetSchema = closedObject({
  kind: Type.Literal("browser"),
  browserRef: OpaqueComputerReferenceSchema,
  pageRef: Type.Optional(OpaqueComputerReferenceSchema),
  observationId: OpaqueComputerReferenceSchema,
});
const ComputerBrowserElementTargetSchema = closedObject({
  kind: Type.Literal("browser"),
  browserRef: OpaqueComputerReferenceSchema,
  pageRef: Type.Optional(OpaqueComputerReferenceSchema),
  elementRef: OpaqueComputerReferenceSchema,
  // Browser element refs are scoped to their source observation/navigation generation.
  observationId: OpaqueComputerReferenceSchema,
});
export const ComputerBrowserTargetSchema = Type.Union([
  ComputerBrowserPageTargetSchema,
  ComputerBrowserElementTargetSchema,
]);

/** A portable v2 target. Its references are opaque and cannot carry native ids or paths. */
export const ComputerTargetSchema = Type.Union([
  ComputerScreenTargetSchema,
  ComputerWindowTargetSchema,
  ComputerElementTargetSchema,
  ComputerBrowserTargetSchema,
]);

const ComputerDesktopPointerTargetSchema = Type.Union([
  ComputerScreenPointTargetSchema,
  ComputerWindowPointTargetSchema,
  ComputerElementTargetSchema,
]);
const ComputerDesktopCoordinateTargetSchema = Type.Union([
  ComputerScreenPointTargetSchema,
  ComputerWindowPointTargetSchema,
]);
const ComputerDesktopKeyboardTargetSchema = Type.Union([
  ComputerScreenTargetSchema,
  ComputerWindowTargetSchema,
  ComputerElementTargetSchema,
]);
const ComputerDesktopViewTargetSchema = Type.Union([
  ComputerScreenTargetSchema,
  ComputerWindowTargetSchema,
]);

const ComputerDeliveryProperties = { deliveryMode: Type.Optional(ComputerDeliveryModeSchema) };
const ComputerPointerActionSchema = Type.Union([
  closedObject({
    name: Type.Literal("left_click"),
    target: ComputerDesktopPointerTargetSchema,
    ...ComputerDeliveryProperties,
  }),
  closedObject({
    name: Type.Literal("right_click"),
    target: ComputerDesktopPointerTargetSchema,
    ...ComputerDeliveryProperties,
  }),
  closedObject({
    name: Type.Literal("middle_click"),
    target: ComputerDesktopPointerTargetSchema,
    ...ComputerDeliveryProperties,
  }),
  closedObject({
    name: Type.Literal("double_click"),
    target: ComputerDesktopPointerTargetSchema,
    ...ComputerDeliveryProperties,
  }),
  closedObject({
    name: Type.Literal("triple_click"),
    target: ComputerDesktopPointerTargetSchema,
    ...ComputerDeliveryProperties,
  }),
  closedObject({
    name: Type.Literal("mouse_move"),
    target: ComputerDesktopPointerTargetSchema,
    ...ComputerDeliveryProperties,
  }),
  closedObject({
    name: Type.Literal("left_click_drag"),
    target: ComputerDesktopCoordinateTargetSchema,
    from: ComputerPointSchema,
    ...ComputerDeliveryProperties,
  }),
  closedObject({
    name: Type.Literal("left_mouse_down"),
    target: ComputerDesktopPointerTargetSchema,
    ...ComputerDeliveryProperties,
  }),
  closedObject({
    name: Type.Literal("left_mouse_up"),
    target: ComputerDesktopPointerTargetSchema,
    ...ComputerDeliveryProperties,
  }),
]);

const ComputerInputActionSchema = Type.Union([
  closedObject({
    name: Type.Literal("type"),
    target: ComputerDesktopKeyboardTargetSchema,
    text: ComputerTextSchema,
    ...ComputerDeliveryProperties,
  }),
  closedObject({
    name: Type.Literal("key"),
    target: ComputerDesktopKeyboardTargetSchema,
    keys: ComputerTextSchema,
    ...ComputerDeliveryProperties,
  }),
  closedObject({
    name: Type.Literal("hold_key"),
    target: ComputerDesktopKeyboardTargetSchema,
    keys: ComputerTextSchema,
    durationMs: Type.Integer({ minimum: 1, maximum: 10_000 }),
    ...ComputerDeliveryProperties,
  }),
  closedObject({
    name: Type.Literal("set_value"),
    target: ComputerElementTargetSchema,
    value: ComputerTextSchema,
    ...ComputerDeliveryProperties,
  }),
  closedObject({
    name: Type.Literal("scroll"),
    target: ComputerDesktopPointerTargetSchema,
    direction: Type.Union([
      Type.Literal("up"),
      Type.Literal("down"),
      Type.Literal("left"),
      Type.Literal("right"),
    ]),
    amount: Type.Integer({ minimum: 1, maximum: 100 }),
    ...ComputerDeliveryProperties,
  }),
  closedObject({
    name: Type.Literal("zoom"),
    target: ComputerDesktopViewTargetSchema,
    direction: Type.Union([Type.Literal("in"), Type.Literal("out")]),
    ...ComputerDeliveryProperties,
  }),
]);

const ComputerObservationActionSchema = Type.Union([
  closedObject({
    name: Type.Literal("screenshot"),
    screenIndex: Type.Optional(Type.Integer({ minimum: 0 })),
  }),
  closedObject({ name: Type.Literal("list_apps") }),
  closedObject({ name: Type.Literal("list_windows") }),
  closedObject({ name: Type.Literal("get_accessibility_tree") }),
  closedObject({ name: Type.Literal("get_cursor_position") }),
  closedObject({
    name: Type.Literal("get_window_state"),
    target: ComputerWindowIdentityTargetSchema,
  }),
  closedObject({
    name: Type.Literal("get_browser_state"),
    target: ComputerBrowserPageTargetSchema,
  }),
]);

const ComputerAppActionSchema = Type.Union([
  closedObject({ name: Type.Literal("launch_app"), appRef: OpaqueComputerReferenceSchema }),
  closedObject({ name: Type.Literal("kill_app"), appRef: OpaqueComputerReferenceSchema }),
  closedObject({ name: Type.Literal("bring_to_front"), appRef: OpaqueComputerReferenceSchema }),
]);

const ComputerBrowserActionSchema = Type.Union([
  closedObject({
    name: Type.Literal("browser_navigate"),
    target: ComputerBrowserPageTargetSchema,
    url: Type.String({ minLength: 1, maxLength: 16_384 }),
  }),
  closedObject({
    name: Type.Literal("browser_click"),
    target: ComputerBrowserElementTargetSchema,
    ...ComputerDeliveryProperties,
  }),
  closedObject({
    name: Type.Literal("browser_type"),
    target: ComputerBrowserElementTargetSchema,
    text: ComputerTextSchema,
    ...ComputerDeliveryProperties,
  }),
  closedObject({
    name: Type.Literal("browser_dialog"),
    target: ComputerBrowserPageTargetSchema,
    accept: Type.Boolean(),
    text: Type.Optional(ComputerTextSchema),
  }),
  closedObject({
    name: Type.Literal("browser_set_input_files"),
    target: ComputerBrowserElementTargetSchema,
    resourceRefs: Type.Array(OpaqueComputerReferenceSchema, { minItems: 1, maxItems: 32 }),
  }),
  closedObject({ name: Type.Literal("browser_download"), target: ComputerBrowserPageTargetSchema }),
  closedObject({
    name: Type.Literal("browser_pointer"),
    target: ComputerBrowserObservationTargetSchema,
    point: ComputerPointSchema,
    ...ComputerDeliveryProperties,
  }),
]);

const ComputerLifecycleActionSchema = Type.Union([
  closedObject({
    name: Type.Literal("wait"),
    durationMs: Type.Integer({ minimum: 0, maximum: 100_000 }),
  }),
]);

/** Closed, one-action v2 union. No provider-native method/argument escape hatch exists. */
export const ComputerActionV2Schema = Type.Union([
  ComputerPointerActionSchema,
  ComputerInputActionSchema,
  ComputerObservationActionSchema,
  ComputerAppActionSchema,
  ComputerBrowserActionSchema,
  ComputerLifecycleActionSchema,
]);

/** Gateway/node-host-injected v2 execution envelope for `computer.act`. */
export const ComputerActV2RequestSchema = closedObject({
  version: Type.Literal(2),
  providerGeneration: ComputerProviderGenerationSchema,
  executionId: OpaqueComputerReferenceSchema,
  action: ComputerActionV2Schema,
});

export const ComputerResourceSchema = closedObject({
  kind: Type.Union([Type.Literal("image"), Type.Literal("download"), Type.Literal("upload")]),
  resourceRef: OpaqueComputerReferenceSchema,
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
  mimeType: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
});

/** Bounded semantic evidence that lets a model select an opaque element reference. */
export const ComputerAccessibilityElementSchema = closedObject({
  elementRef: OpaqueComputerReferenceSchema,
  role: Type.String({ minLength: 1, maxLength: 128 }),
  label: Type.Optional(ComputerElementTextSchema),
  value: Type.Optional(ComputerElementTextSchema),
  bounds: ComputerBoundsSchema,
  supportedActions: Type.Array(ComputerActionNameSchema, { maxItems: 16 }),
});

export const ComputerObservationSchema = closedObject({
  observationId: OpaqueComputerReferenceSchema,
  kind: ComputerObservationClassSchema,
  target: ComputerTargetSchema,
  resourceRefs: Type.Array(OpaqueComputerReferenceSchema, { maxItems: 32 }),
  elements: Type.Optional(Type.Array(ComputerAccessibilityElementSchema, { maxItems: 256 })),
  truncated: Type.Optional(Type.Boolean()),
  degraded: Type.Optional(Type.Boolean()),
});

export const ComputerActErrorCodeSchema = Type.Union([
  Type.Literal("COMPUTER_STALE_PROVIDER"),
  Type.Literal("COMPUTER_STALE_EXECUTION"),
  Type.Literal("COMPUTER_STALE_FRAME"),
  Type.Literal("COMPUTER_STALE_OBSERVATION"),
  Type.Literal("COMPUTER_STALE_ELEMENT"),
  Type.Literal("COMPUTER_STALE_BROWSER"),
  Type.Literal("COMPUTER_UNSUPPORTED_ACTION"),
  Type.Literal("COMPUTER_UNSUPPORTED_DELIVERY"),
  Type.Literal("COMPUTER_HOST_BUSY"),
  Type.Literal("COMPUTER_MISSING_PERMISSION"),
  Type.Literal("COMPUTER_BACKEND_UNAVAILABLE"),
]);
export const ComputerActV2ErrorSchema = closedObject({
  code: ComputerActErrorCodeSchema,
  reasonCode: Type.Optional(ComputerReasonCodeSchema),
});

const ComputerActV2ResultProperties = {
  provider: closedObject({
    id: ComputerProviderIdSchema,
    generation: ComputerProviderGenerationSchema,
  }),
  effect: Type.Optional(
    Type.Union([
      Type.Literal("confirmed"),
      Type.Literal("unverifiable"),
      Type.Literal("suspected_noop"),
    ]),
  ),
  verified: Type.Optional(Type.Boolean()),
  escalation: Type.Optional(
    closedObject({
      recommended: Type.Union([
        Type.Literal("window-pixel"),
        Type.Literal("browser"),
        Type.Literal("foreground"),
        Type.Literal("desktop"),
      ]),
      reasonCode: ComputerReasonCodeSchema,
    }),
  ),
  observation: Type.Optional(ComputerObservationSchema),
  resources: Type.Optional(Type.Array(ComputerResourceSchema, { maxItems: 32 })),
  // Provider diagnostics are bounded evidence, never an action escape hatch or portable decision field.
  details: Type.Optional(
    Type.Record(Type.String({ minLength: 1, maxLength: 128 }), Type.Unknown(), {
      maxProperties: 64,
    }),
  ),
};

/** Portable v2 result: failures carry one closed actionable error code. */
export const ComputerActV2ResultSchema = Type.Union([
  closedObject({ ok: Type.Literal(true), ...ComputerActV2ResultProperties }),
  closedObject({
    ok: Type.Literal(false),
    error: ComputerActV2ErrorSchema,
    ...ComputerActV2ResultProperties,
  }),
]);

export type ComputerUseCapabilities = Static<typeof ComputerUseCapabilitiesSchema>;
export type ComputerUseReadiness = Static<typeof ComputerUseReadinessSchema>;
export type ComputerActionName = Static<typeof ComputerActionNameSchema>;
export type ComputerTargetClass = Static<typeof ComputerTargetClassSchema>;
export type ComputerDeliveryMode = Static<typeof ComputerDeliveryModeSchema>;
export type ComputerObservationClass = Static<typeof ComputerObservationClassSchema>;
export type OpaqueComputerReference = Static<typeof OpaqueComputerReferenceSchema>;
export type ComputerTarget = Static<typeof ComputerTargetSchema>;
export type ComputerActionV2 = Static<typeof ComputerActionV2Schema>;
export type ComputerActV2Request = Static<typeof ComputerActV2RequestSchema>;
export type ComputerResource = Static<typeof ComputerResourceSchema>;
export type ComputerAccessibilityElement = Static<typeof ComputerAccessibilityElementSchema>;
export type ComputerObservation = Static<typeof ComputerObservationSchema>;
export type ComputerActErrorCode = Static<typeof ComputerActErrorCodeSchema>;
export type ComputerActV2Error = Static<typeof ComputerActV2ErrorSchema>;
export type ComputerActV2Result = Static<typeof ComputerActV2ResultSchema>;
