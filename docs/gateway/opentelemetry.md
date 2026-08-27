---
summary: "Export Afora diagnostics to OpenTelemetry collectors or stdout JSONL via the diagnostics-otel plugin"
title: "OpenTelemetry export"
read_when:
  - You want to send Afora model usage, message flow, or session metrics to an OpenTelemetry collector
  - You are wiring traces, metrics, or logs into Grafana, Datadog, Honeycomb, New Relic, Tempo, or another OTLP backend
  - You need the exact metric names, span names, or attribute shapes to build dashboards or alerts
---

Afora exports diagnostics through the official `diagnostics-otel` plugin
using **OTLP/HTTP (protobuf)**. Logs can also be written as stdout JSONL for
container and sandbox log pipelines. Any collector or backend that accepts
OTLP/HTTP works without code changes. For local file logs, see
[Logging](/logging).

- **Diagnostics events** are structured, in-process records emitted by the
  Gateway and bundled plugins for model runs, message flow, sessions, queues,
  and exec.
- **`diagnostics-otel`** subscribes to those events and exports them as
  OpenTelemetry **metrics**, **traces**, and **logs** over OTLP/HTTP, and can
  mirror log records to stdout JSONL.
- **Provider calls** receive a W3C `traceparent` header from the actual current
  OpenTelemetry model-call span when the provider transport accepts custom
  headers. Diagnostic IDs remain local correlation keys, and plugin-emitted
  trace context is not propagated.
- Exporters attach only when both the diagnostics surface and the plugin are
  enabled, so in-process cost stays near zero by default.

## Quick start

```bash
afora plugins install clawhub:@afora/diagnostics-otel
```

```json5
{
  plugins: {
    allow: ["diagnostics-otel"],
    entries: {
      "diagnostics-otel": { enabled: true },
    },
  },
  diagnostics: {
    enabled: true,
    otel: {
      enabled: true,
      endpoint: "http://otel-collector:4318",
      protocol: "http/protobuf",
      serviceName: "afora-gateway",
      traces: true,
      metrics: true,
      logs: true,
      sampleRate: 0.2,
      flushIntervalMs: 60000,
    },
  },
}
```

Or enable the plugin from the CLI: `afora plugins enable diagnostics-otel`.

<Note>
`diagnostics.otel.protocol` accepts only `http/protobuf`. If a persisted config,
including a value supplied through `${VAR}` interpolation, still resolves this
field to the retired `grpc` value, run
[`afora doctor --fix`](/cli/doctor). Doctor repairs directly authored values
and a sole internal single-file include that owns the top-level `diagnostics`
section. For root or array includes, nested include chains, sibling overrides,
external include targets, or another ambiguous source, Doctor leaves the files
unchanged and lists the candidate source file or files to edit manually.

When `diagnostics.otel.protocol` is unset, each plugin-owned OTLP signal first
checks its nonblank `OTEL_EXPORTER_OTLP_*_PROTOCOL` value, then
`OTEL_EXPORTER_OTLP_PROTOCOL`, then defaults to `http/protobuf`. Doctor does not
rewrite process environment variables. An unsupported value disables only that
plugin-owned OTLP signal; supported sibling signals continue, as does the stdout
branch of `logsExporter: "both"`. Preloaded trace and metric SDKs own their own
transport selection and are not rejected by this plugin.
</Note>

## Signals exported

| Signal      | What goes in it                                                                                                                                                                                              |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Metrics** | Counters/histograms for token usage, cost, run duration, failover, skill usage, message flow, Talk events, queue lanes, session state/recovery, tool execution, exec, memory, liveness, and exporter health. |
| **Traces**  | Spans for model usage, model calls, harness lifecycle, skill usage, tool execution, exec, webhook/message processing, context assembly, and tool loops.                                                      |
| **Logs**    | Structured `logging.file` records exported over OTLP or stdout JSONL when `diagnostics.otel.logs` is enabled; log bodies are withheld unless content capture is explicitly enabled.                          |

Toggle `traces`, `metrics`, and `logs` independently. Traces and metrics
default to on when `diagnostics.otel.enabled` is true; logs default to off
and export only when `diagnostics.otel.logs` is explicitly `true`. Log export
defaults to OTLP; set `diagnostics.otel.logsExporter` to `stdout` for JSONL on
stdout, or `both` for both.

<Note>
The shared `endpoint` and `OTEL_EXPORTER_OTLP_ENDPOINT` are bases for all
enabled signals. Afora appends `/v1/traces`, `/v1/metrics`, or `/v1/logs`
to root and custom collector paths. For compatibility with hosted frontends,
a shared endpoint already ending in one of those signal paths keeps that path
for its matching signal and replaces the terminal segment for the others.

Signal-specific `tracesEndpoint`, `metricsEndpoint`, and `logsEndpoint`
settings, plus their matching `OTEL_EXPORTER_OTLP_*_ENDPOINT` fallbacks, are
passed to the exporter as exact URLs. Afora does not append or rewrite their
paths.
</Note>

## Which processes export

- **Gateway** starts the exporter at startup and exports from the Gateway
  process for every run it executes, including `afora agent` turns
  dispatched to it.
- **One-shot local runs** (`afora agent --local`) execute in the CLI
  process. When OTel export is configured and
  the plugin is enabled, that same CLI process starts one exporter instance for
  the run and flushes buffered spans, metrics, and logs before the process exits.
  The CLI waits at most 5 seconds for the diagnostic-event queue to drain and 10
  more for the flush, so an unreachable collector cannot hold the command open.
  A collector that accepts the connection but never answers can still delay exit
  until the exporter's own request timeout (`OTEL_EXPORTER_OTLP_TIMEOUT`).
  In JSON output mode, these one-shot runs suppress only the stdout JSONL log
  sink so command stdout stays reserved for the JSON response; OTLP traces,
  metrics, and logs continue when configured.
- `afora agent exec` also runs the agent embedded in the CLI process, but
  does not yet start this exporter, so its runs export no telemetry. Dispatch
  through the Gateway, or use `afora agent --local`, when you need traces
  from a headless run.

## Exporter health

`afora doctor` and `afora status --all` show a bounded, redacted snapshot
of the running Gateway's latest trusted exporter state for each signal and
transport. For `diagnostics-otel`, the snapshot distinguishes:

- OTLP/HTTP protobuf with an endpoint supplied by config or an `OTEL_*`
  environment fallback.
- OTLP/HTTP protobuf using the exporter dependency's default endpoint because
  no endpoint was supplied.
- Stdout log export.
- Trace or metric export owned by an externally preloaded OpenTelemetry SDK.

OTLP export failure and recovery transitions are recorded from the exporter's
final result callback, after dependency-owned retries finish. A retryable
response that later succeeds is therefore not reported as a failure. Startup,
log preparation or emit, export, and shutdown failures use fixed reason
categories rather than raw errors.

The snapshot never includes endpoint values, headers, certificates, payloads,
or raw error messages. Transport is retained only in this local health
projection. It is not added to the existing
`afora.telemetry.exporter.events` metric attributes, and existing Prometheus
label sets are unchanged.

## Configuration reference

```json5
{
  diagnostics: {
    enabled: true,
    otel: {
      enabled: true,
      endpoint: "http://otel-collector:4318",
      tracesEndpoint: "http://otel-collector:4318/v1/traces",
      metricsEndpoint: "http://otel-collector:4318/v1/metrics",
      logsEndpoint: "http://otel-collector:4318/v1/logs",
      protocol: "http/protobuf",
      serviceName: "afora-gateway", // unset falls back to OTEL_SERVICE_NAME, then "afora"
      metricNamePrefix: "acme.", // optional; include the separator
      headers: { "x-collector-token": "..." },
      traces: true,
      metrics: true,
      logs: true,
      logsExporter: "otlp", // otlp | stdout | both
      sampleRate: 0.2, // root-span sampler, 0.0..1.0
      flushIntervalMs: 60000, // metric export interval (min 1000ms)
      captureContent: false,
    },
  },
}
```

`metricNamePrefix` replaces the default `afora.` prefix only on
Afora-owned metrics. For example, `"acme."` exports `afora.tokens` as
`acme.tokens`; set it to `""` to export `tokens` with no prefix. Non-empty
values must start with an ASCII letter, use only letters, digits, underscores,
dots, hyphens, and slashes, and contain at most 128 characters. Set it to
`"acme.afora."` if you want `acme.afora.tokens`. Standard
semantic-convention metrics such as
`gen_ai.client.token.usage` and `gen_ai.client.operation.duration` keep their
original names. Leave the option unset to preserve every current metric name.
Enabling or changing this option renames the affected metric series, so update
dashboards, alerts, and recording rules that query the old names.

### Environment variables

| Variable                                                                                                                                                                                                                               | Purpose                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OTEL_EXPORTER_OTLP_ENDPOINT`                                                                                                                                                                                                          | Fallback for `diagnostics.otel.endpoint` when the config key is unset.                                                                                                                                                                                                                                                                                                           |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` / `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` / `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`                                                                                                                      | Signal-specific endpoint fallbacks used when the matching `diagnostics.otel.*Endpoint` config key is unset. Signal-specific config wins over signal-specific env, which wins over the shared endpoint.                                                                                                                                                                           |
| `OTEL_SERVICE_NAME`                                                                                                                                                                                                                    | Fallback for `diagnostics.otel.serviceName` when the config key is unset. Default service name is `afora`.                                                                                                                                                                                                                                                                    |
| `OTEL_EXPORTER_OTLP_PROTOCOL`                                                                                                                                                                                                          | Shared process-environment fallback used when `diagnostics.otel.protocol` and the signal-specific protocol variable are unset. Only `http/protobuf` enables a plugin-owned OTLP exporter.                                                                                                                                                                                        |
| `OTEL_EXPORTER_OTLP_TRACES_PROTOCOL` / `OTEL_EXPORTER_OTLP_METRICS_PROTOCOL` / `OTEL_EXPORTER_OTLP_LOGS_PROTOCOL`                                                                                                                      | Signal-specific protocol fallbacks used when `diagnostics.otel.protocol` is unset. A nonblank signal-specific value wins over the shared protocol value. Unsupported values disable only that plugin-owned OTLP signal.                                                                                                                                                          |
| `OTEL_PROPAGATORS`                                                                                                                                                                                                                     | Propagators registered for each plugin-owned generation, including when `OTEL_SDK_DISABLED=true`. Defaults to `tracecontext,baggage`; `none` disables automatic propagation. Values are case-insensitive. Unavailable values and deprecated `jaeger` usage emit a plugin warning.                                                                                                |
| `OTEL_SDK_DISABLED`                                                                                                                                                                                                                    | A case-insensitive `true` disables all plugin-owned trace, metric, log, and stdout routes before endpoint, protocol, or TLS setup. Any other value leaves the SDK enabled; unrecognized values emit a plugin warning and fall back to `false`. Async context and `OTEL_PROPAGATORS` remain active.                                                                               |
| `OTEL_NODE_RESOURCE_DETECTORS`                                                                                                                                                                                                         | Selects resource detectors for plugin-owned trace and metric providers. Supported tokens are `env`, `host`, `os`, `process`, and `serviceinstance`; `all` runs them in host, OS, service-instance, process, environment order, while `none` disables detection. The default is environment, process, then host. Explicit Afora service config wins detector attributes.       |
| `OTEL_TRACES_SAMPLER` / `OTEL_TRACES_SAMPLER_ARG`                                                                                                                                                                                      | Standard OpenTelemetry sampler selection used when `diagnostics.otel.sampleRate` is unset. An explicit `sampleRate` remains the higher-precedence Afora sampler.                                                                                                                                                                                                              |
| `OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT` / `OTEL_SPAN_ATTRIBUTE_VALUE_LENGTH_LIMIT` / `OTEL_SPAN_EVENT_COUNT_LIMIT` / `OTEL_SPAN_LINK_COUNT_LIMIT` / `OTEL_SPAN_ATTRIBUTE_PER_EVENT_COUNT_LIMIT` / `OTEL_SPAN_ATTRIBUTE_PER_LINK_COUNT_LIMIT` | Standard OpenTelemetry span limits applied by each plugin-owned tracer provider.                                                                                                                                                                                                                                                                                                 |
| `OTEL_BSP_MAX_QUEUE_SIZE` / `OTEL_BSP_MAX_EXPORT_BATCH_SIZE` / `OTEL_BSP_SCHEDULE_DELAY` / `OTEL_BSP_EXPORT_TIMEOUT`                                                                                                                   | Batch span processor settings for plugin-owned trace export. Values must be positive; invalid values use OpenTelemetry defaults. Export batch size is capped at queue size.                                                                                                                                                                                                      |
| `OTEL_METRIC_EXPORT_INTERVAL` / `OTEL_METRIC_EXPORT_TIMEOUT`                                                                                                                                                                           | Periodic metric export interval and timeout for plugin-owned metrics. Values must be positive; invalid values use OpenTelemetry defaults, and timeout is capped at the active interval. `diagnostics.otel.flushIntervalMs` overrides the interval.                                                                                                                               |
| `OTEL_NODE_EXPERIMENTAL_SDK_METRICS`                                                                                                                                                                                                   | Enables OpenTelemetry SDK self-observation metrics for the private meter, tracer, and batch span processor when set to `true`.                                                                                                                                                                                                                                                   |
| `OTEL_LOG_LEVEL`                                                                                                                                                                                                                       | Owned mode does not replace the process-global OpenTelemetry diagnostic logger because the public SDK APIs expose no generation-private equivalent. A preload or host may configure this variable before Afora starts; the plugin preserves that external diagnostic owner.                                                                                                   |
| `OTEL_SEMCONV_STABILITY_OPT_IN`                                                                                                                                                                                                        | Set to `gen_ai_latest_experimental` to emit the latest GenAI inference span shape: `{gen_ai.operation.name} {gen_ai.request.model}` span names, `CLIENT` span kind, and `gen_ai.provider.name` instead of the legacy `gen_ai.system`. GenAI metrics always use bounded, low-cardinality attributes regardless.                                                                   |
| `AFORA_OTEL_PRELOADED`                                                                                                                                                                                                              | Set to `1` when another preload or host process already registered global OpenTelemetry providers. The plugin consumes external trace, metric, context, propagation, and logger ownership without registering, replacing, disabling, unregistering, or shutting it down. With `OTEL_SDK_DISABLED=true`, external ownership remains active while plugin-owned logs stay disabled. |

Without `AFORA_OTEL_PRELOADED=1`, trace, metric, and log providers are
generation-private. The plugin publishes only its async context manager and
propagator through the public OpenTelemetry APIs, and removes them only while
those public behaviors still match the generation being stopped. A replacement
host or later generation therefore keeps ownership through cleanup.

## Continue an upstream WebSocket trace

An authenticated Gateway WebSocket client can attach a W3C `traceparent` to
each request frame:

```json
{
  "type": "req",
  "id": "eval-item-42",
  "method": "agent",
  "params": {},
  "traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
}
```

The Gateway creates a child request context that preserves the upstream trace
ID and sampling flags. Agent, harness, model-call, provider, tool-execution, and
exec spans created inside the request remain on that trace, including spans
recorded after their parent run has already finished. This allows a local
experiment runner to create one Langfuse/OpenTelemetry trace per dataset item and
correlate the corresponding Afora execution.

Trace context is request-scoped, not connection-scoped. On a long-lived
WebSocket, generate or inject the appropriate `traceparent` independently for
every RPC. Concurrent requests remain isolated even when their work
interleaves.

The field is accepted only after the existing Gateway authentication handshake
and does not affect authentication or method authorization. A `traceparent` on
the initial `connect` frame is ignored. Missing or syntactically malformed
values within the 128-character field limit silently fall back to a fresh
request trace; longer values make the request frame invalid. `tracestate` and
`baggage` are not accepted by the Gateway WebSocket protocol.

## Privacy and content capture

Raw model/tool content is **not** exported by default. Spans carry bounded
identifiers (channel, provider, model, error category, hash-only request ids,
tool source, tool owner, skill name/source) and never include prompt text,
response text, tool inputs, tool outputs, skill file paths, or session keys.
Values that look like scoped agent session keys (for example starting with
`agent:`) are replaced with `unknown` on low-cardinality attributes. OTLP log
records keep severity, logger, code location, trusted trace context, and
sanitized attributes by default; the raw log message body is exported only
when `diagnostics.otel.captureContent` is `true`. Talk metrics export only
bounded event metadata (mode, transport, provider, event type) - no
transcripts, audio payloads, session ids, turn ids, call ids, room ids, or
handoff tokens.

When `diagnostics-otel` tracing is active, outbound model requests may include
a W3C `traceparent` header from the actual exporter-owned model-call span.
Diagnostic trace IDs and span IDs only correlate events to that span; they are
not used as outbound OTel identities. If the exporter cannot resolve a real
span context, Afora omits the header instead of naming an unexported parent.
Existing caller-supplied `traceparent` headers are removed or replaced, so
plugins or custom provider options cannot spoof cross-service trace ancestry.

Set `diagnostics.otel.captureContent` to `true` only when your collector and
retention policy are approved for prompt, response, tool, and tool-definition
text. This enables bounded, redacted input messages, output messages, tool
inputs, tool outputs, tool definitions, and OTLP log bodies. System prompts
remain excluded. Provider-internal `thinking` and `redacted_thinking` payloads
are also excluded: compatibility attributes retain only a redacted structural
marker, while GenAI message attributes omit those parts.

`toolInputs`/`toolOutputs` content is captured for the built-in agent
runtime's tool executions (`afora.content.tool_input` and
`gen_ai.tool.call.arguments` on completed/error spans;
`afora.content.tool_output` and `gen_ai.tool.call.result` on completed
spans). The `afora.content.*` names remain the stable Afora attribute
names; the `gen_ai.tool.call.*` copies mirror them for semconv-native viewers.
External harness tool calls (Codex, Claude CLI) emit
`tool.execution.*` spans without content payloads. Captured content travels on a
trusted, listener-only channel and is never placed on the public diagnostic event
bus.

## Sampling and flushing

- **Traces:** `diagnostics.otel.sampleRate` sets a `TraceIdRatioBasedSampler`
  on the root span only (`0.0` drops all, `1.0` keeps all). Unset uses the
  OpenTelemetry SDK default (always-on).
- **Metrics:** `diagnostics.otel.flushIntervalMs` (clamped to a minimum of
  `1000`); unset uses the SDK's periodic-export default.
- **Logs:** OTLP logs respect `logging.level` (file log level) and use the
  diagnostic log-record redaction path, not console formatting. High-volume
  installs should prefer OTLP collector sampling/filtering over local
  sampling. Set `diagnostics.otel.logsExporter: "stdout"` when your platform
  already ships stdout/stderr to a log processor and you have no OTLP logs
  collector. Stdout records are one JSON object per line with `ts`, `signal`,
  `service.name`, severity, body, redacted attributes, and trusted trace
  fields when available.
- **File-log correlation:** JSONL file logs include top-level `traceId`,
  `spanId`, `parentSpanId`, and `traceFlags` when the log call carries a valid
  diagnostic trace context, letting log processors join local log lines with
  exported spans.
- **Request correlation:** Gateway HTTP requests and WebSocket frames create
  an internal request trace scope. Logs and diagnostic events inside that
  scope inherit the request trace by default, while agent run and model-call
  spans are created as children so provider `traceparent` headers stay on the
  same trace.
- **Model-call correlation:** `afora.model.call` spans include safe prompt
  component sizes by default and per-call token attributes when the provider
  result exposes usage. `afora.model.usage` remains the run-level
  accounting span for aggregate cost, context, and channel dashboards, and
  stays on the same diagnostic trace when the emitting runtime has trusted
  trace context.

### Model-call observation units

Every `afora.model.call` span identifies what its lifecycle measures through
`afora.model_call.observation_unit`:

- `request` - one observable model/provider request. Native embedded model
  calls use this unit, and exporters treat a missing value as `request` for
  compatibility with older or external emitters.
- `turn` - one opaque agent CLI turn that may contain hidden model requests,
  retries, tool work, or background work. Claude Code CLI and Codex app-server
  calls use this unit.

Both units remain model-call spans so trace backends can render model input,
output, usage, and hierarchy. Request spans use the API-derived GenAI operation
(`chat`, `generate_content`, or `text_completion`), while turn spans use
`gen_ai.operation.name = invoke_agent`. Both contribute to
`gen_ai.client.operation.duration`, where the operation name keeps direct
request latency separate from full-turn latency. Afora's OTEL model-call
metrics also include `afora.model_call.observation_unit`; the Prometheus
model-call metrics expose the equivalent `observation_unit` label.

### Claude Code CLI model-call fidelity

Claude Code CLI turns emit one synthetic, turn-level `afora.model.call`
span. These are not Anthropic HTTP request spans. They use `afora.api =
claude-code`, `afora.model_call.observation_unit = turn`, and identify
the operation as `gen_ai.operation.name = invoke_agent`. They identify
Afora's CLI boundary through
`afora.transport`:

- `stdio` - one-shot local Claude Code process.
- `stdio-live` - one turn on a managed persistent Claude stdio session.
- `paired-node-cli` - one-shot Claude Code execution delegated to a paired
  node.

Claude CLI diagnostics are instantiated only while the process diagnostic
dispatcher is enabled and an internal or trusted event listener is attached.
With no observability plugin or other listener active, Claude CLI turns skip
the synthetic trace hierarchy, content buffers, and diagnostic stream-byte
accounting. When content capture is enabled, prompt and system-prompt fields
are capped at 128 KiB each; assistant output is capped at 128 KiB across at
most 200 envelopes, with 16 KiB and one item reserved for a final visible
fallback response. A marker records truncation when the limit is reached.

Afora gives Claude CLI turns the same ownership hierarchy used by other
agent runtimes: `afora.harness.run` (`afora.harness.id = claude-cli`)
contains `afora.run`, which contains the Claude `afora.model.call`
span. The harness and run spans are synthetic Afora turn boundaries, not
Claude Code internal phases. One-shot and managed stdio turns use the same
hierarchy; a real fresh-session retry creates another model-call child inside
the same Afora run.

The span starts when Afora admits the prepared CLI turn and ends only after
that turn succeeds or fails. For managed sessions, an interim success result
does not end the span while Claude reports result-holding background agents or
workflows; the final post-drain result does. Abort, timeout, process failure,
output/parse failure, and other turn failures end the same span with an error.

Claude Code reports per-assistant-message usage and may also report cumulative
usage on its terminal result. Afora reply accounting continues to use the
last assistant message so existing cost semantics do not change; the
turn-level model-call span uses terminal cumulative usage when available,
including cache-read and cache-creation tokens.

For these CLI spans, byte and timing fields describe the observable Afora
CLI boundary:

- `afora.model_call.request_bytes` is the UTF-8 size of the prompt value
  sent over one-shot stdin/argv, or the managed stdio JSONL user envelope. It
  is not the size of Claude Code's hidden model request.
- `afora.model_call.response_bytes` is the UTF-8 size of Claude CLI stdout
  observed during the turn. It is not Anthropic HTTP response size.
- `afora.model_call.time_to_first_byte_ms` is time to the first observable
  Claude CLI stdout or stderr output. It is not network TTFB.

With `captureContent` enabled, the span exports the effective prompt Afora
sends to Claude Code and visible assistant text/tool-call identity
through `gen_ai.input.messages` and `gen_ai.output.messages`. Tool arguments,
internal thinking, opaque thinking signatures, tool results, and system prompts
are omitted from the Claude assistant envelope. Afora does not
claim access to Claude Code's private system prompt, hidden resumed or
compacted request payload, native internal tool schemas, raw Anthropic HTTP
request, internal retries, upstream request id, or true network TTFB. Because
Claude Code does not expose its effective native tool definitions accurately,
these spans do not populate `gen_ai.tool.definitions`.

External Claude harness tool spans remain metadata-only even when tool content
capture is enabled. As with every model span, captured Claude CLI content uses
the trusted listener-only path and the exporter's existing redaction and size
bounds; content remains off by default.

## Exported metrics

### Model usage

- `afora.tokens` (counter, attrs: `afora.token`, `afora.channel`, `afora.provider`, `afora.model`, `afora.agent`)
- `afora.cost.usd` (counter, attrs: `afora.channel`, `afora.provider`, `afora.model`)
- `afora.run.duration_ms` (histogram, attrs: `afora.channel`, `afora.provider`, `afora.model`)
- `afora.context.tokens` (histogram, attrs: `afora.context`, `afora.channel`, `afora.provider`, `afora.model`)
- `gen_ai.client.token.usage` (histogram, GenAI semantic-conventions metric, attrs: `gen_ai.token.type` = `input`/`output`, `gen_ai.provider.name`, `gen_ai.operation.name`, `gen_ai.request.model`)
- `gen_ai.client.operation.duration` (histogram, seconds, GenAI semantic-conventions metric for model requests and synthetic agent turns; attrs: `gen_ai.provider.name`, `gen_ai.operation.name`, `gen_ai.request.model`, optional `error.type`; turn observations use `gen_ai.operation.name = invoke_agent`)
- `afora.model_call.duration_ms` (histogram, attrs: `afora.provider`, `afora.model`, `afora.api`, `afora.transport`, `afora.model_call.observation_unit`, plus `afora.errorCategory` and `afora.failureKind` on classified errors)
- `afora.model_call.request_bytes` (histogram, UTF-8 byte size of the final model request payload; for Claude Code CLI, the observable prompt input/envelope described above; no raw payload content)
- `afora.model_call.response_bytes` (histogram, UTF-8 byte size of streamed response chunk payloads; high-frequency text, thinking, and tool-call deltas count only incremental `delta` bytes; for Claude Code CLI, observed stdout bytes; no raw response content)
- `afora.model_call.time_to_first_byte_ms` (histogram, elapsed time before the first streamed response event; for Claude Code CLI, first observable CLI output rather than network TTFB)
- `afora.model.failover` (counter, attrs: `afora.provider`, `afora.model`, `afora.failover.to_provider`, `afora.failover.to_model`, `afora.failover.reason`, `afora.failover.suspended`, `afora.lane`)
- `afora.skill.used` (counter, attrs: `afora.skill.name`, `afora.skill.source`, `afora.skill.activation`, optional `afora.agent`, optional `afora.toolName`)

### Message flow

- `afora.webhook.received` (counter, attrs: `afora.channel`, `afora.webhook`)
- `afora.webhook.error` (counter, attrs: `afora.channel`, `afora.webhook`)
- `afora.webhook.duration_ms` (histogram, attrs: `afora.channel`, `afora.webhook`)
- `afora.message.queued` (counter, attrs: `afora.channel`, `afora.source`)
- `afora.message.received` (counter, attrs: `afora.channel`, `afora.source`)
- `afora.message.dispatch.started` (counter, attrs: `afora.channel`, `afora.source`)
- `afora.message.dispatch.completed` (counter, attrs: `afora.channel`, `afora.outcome`, `afora.reason`, `afora.source`)
- `afora.message.dispatch.duration_ms` (histogram, attrs: `afora.channel`, `afora.outcome`, `afora.reason`, `afora.source`)
- `afora.message.processed` (counter, attrs: `afora.channel`, `afora.outcome`)
- `afora.message.duration_ms` (histogram, attrs: `afora.channel`, `afora.outcome`)
- `afora.message.delivery.started` (counter, attrs: `afora.channel`, `afora.delivery.kind`)
- `afora.message.delivery.duration_ms` (histogram, attrs: `afora.channel`, `afora.delivery.kind`, `afora.outcome`, `afora.errorCategory`)

### Talk

- `afora.talk.event` (counter, attrs: `afora.talk.event_type`, `afora.talk.mode`, `afora.talk.transport`, `afora.talk.brain`, `afora.talk.provider`)
- `afora.talk.event.duration_ms` (histogram, attrs: same as `afora.talk.event`; emitted when a Talk event reports duration)
- `afora.talk.audio.bytes` (histogram, attrs: same as `afora.talk.event`; emitted for Talk audio frame events that report byte length)

### Queues and sessions

- `afora.queue.lane.enqueue` (counter, attrs: `afora.lane`)
- `afora.queue.lane.dequeue` (counter, attrs: `afora.lane`)
- `afora.queue.depth` (histogram, attrs: `afora.lane` or `afora.channel=heartbeat`)
- `afora.queue.wait_ms` (histogram, attrs: `afora.lane`)
- `afora.session.state` (counter, attrs: `afora.state`, `afora.reason`)
- `afora.session.stuck` (counter, attrs: `afora.state`; emitted for recoverable stale session bookkeeping)
- `afora.session.stuck_age_ms` (histogram, attrs: `afora.state`; emitted for recoverable stale session bookkeeping)
- `afora.session.turn.created` (counter, attrs: `afora.agent`, `afora.channel`, `afora.trigger`)
- `afora.session.recovery.requested` (counter, attrs: `afora.state`, `afora.action`, `afora.active_work_kind`, `afora.reason`)
- `afora.session.recovery.completed` (counter, attrs: `afora.state`, `afora.action`, `afora.status`, `afora.active_work_kind`, `afora.reason`)
- `afora.session.recovery.age_ms` (histogram, attrs: same as the matching recovery counter)
- `afora.run.attempt` (counter, attrs: `afora.attempt`)

### Session liveness telemetry

A `processing` session does not age toward the built-in liveness threshold while Afora observes reply, tool, status, block, or ACP runtime progress. Typing keepalives do not count as progress, so a silent model or harness can still be detected.

Afora classifies sessions by the work it can still observe:

- `session.long_running`: active embedded work, model calls, or tool calls
  are still making progress. Owned silent model calls also report as long-running before the built-in abort threshold, so slow or non-streaming model providers do not look like stalled gateway sessions while abort-observable.
- `session.stalled`: active work exists, but the active run has not reported
  recent progress. Owned model calls switch from `session.long_running` to
  `session.stalled` at or after the built-in abort threshold; ownerless
  stale model/tool activity is not treated as harmless long-running work.
  Stalled embedded runs stay observe-only at first, then abort-drain after
  the abort threshold with no progress so queued turns behind the lane can resume.
- `session.stuck`: stale session bookkeeping with no active work, or an idle
  queued session with stale ownerless model/tool activity. This releases the
  affected session lane immediately after recovery gates pass.

Recovery emits structured `session.recovery.requested` and
`session.recovery.completed` events. Diagnostic session state is marked idle
only after a mutating recovery outcome (`aborted` or `released`) and only if
the same processing generation is still current.

Only `session.stuck` emits the `afora.session.stuck` counter, the
`afora.session.stuck_age_ms` histogram, and the `afora.session.stuck`
span. Repeated `session.stuck` diagnostics back off while the session remains
unchanged, so dashboards should alert on sustained increases rather than
every heartbeat tick. For the config knob and defaults, see
[Configuration reference](/gateway/configuration-reference#diagnostics).

Liveness warnings also emit:

- `afora.liveness.warning` (counter, attrs: `afora.liveness.reason`)
- `afora.liveness.event_loop_delay_p99_ms` (histogram, attrs: `afora.liveness.reason`)
- `afora.liveness.event_loop_delay_max_ms` (histogram, attrs: `afora.liveness.reason`)
- `afora.liveness.event_loop_utilization` (histogram, attrs: `afora.liveness.reason`)
- `afora.liveness.cpu_core_ratio` (histogram, attrs: `afora.liveness.reason`)

### Harness lifecycle

- `afora.harness.duration_ms` (histogram, attrs: `afora.harness.id`, `afora.harness.plugin`, `afora.outcome`, `afora.harness.phase` on errors)

### Tool execution and loop detection

- `afora.tool.execution.duration_ms` (histogram, attrs: `gen_ai.tool.name`, `afora.toolName`, `afora.tool.source`, `afora.tool.owner`, `afora.tool.params.kind`, plus `afora.errorCategory` on errors)
- `afora.tool.execution.blocked` (counter, attrs: `gen_ai.tool.name`, `afora.toolName`, `afora.tool.source`, `afora.tool.owner`, `afora.tool.params.kind`, `afora.deniedReason`)
- `afora.tool.loop` (counter, attrs: `afora.toolName`, `afora.loop.level`, `afora.loop.action`, `afora.loop.detector`, `afora.loop.count`, optional `afora.loop.paired_tool`; emitted when a repetitive tool-call loop is detected)

### Exec

- `afora.exec.duration_ms` (histogram, attrs: `afora.exec.target`, `afora.exec.mode`, `afora.outcome`, `afora.failureKind`)

### Diagnostics internals (memory, payloads, exporter health)

- `afora.payload.large` (counter, attrs: `afora.payload.surface`, `afora.payload.action`, `afora.channel`, `afora.plugin`, `afora.reason`)
- `afora.payload.large_bytes` (histogram, attrs: same as `afora.payload.large`)
- `afora.memory.rss_bytes` / `afora.memory.heap_used_bytes` / `afora.memory.heap_total_bytes` / `afora.memory.external_bytes` / `afora.memory.array_buffers_bytes` (histograms, no attrs; process memory samples)
- `afora.memory.pressure` (counter, attrs: `afora.memory.level`, `afora.memory.reason`)
- `afora.diagnostic.async_queue.dropped` (counter, attrs: `afora.diagnostic.async_queue.drop_class`; internal diagnostic-queue backpressure drops)
- `afora.telemetry.exporter.events` (counter, attrs: `afora.exporter`, `afora.signal`, `afora.status`, optional `afora.reason`, optional `afora.errorCategory`; exporter lifecycle/failure self-telemetry)

## Exported spans

- `afora.model.usage`
  - `afora.channel`, `afora.provider`, `afora.model`
  - Optional host-derived `afora.plugin` only for trusted plugin runtime completions
  - `afora.tokens.*` (input/output/cache_read/cache_write/total)
  - `gen_ai.system` by default, or `gen_ai.provider.name` when the latest GenAI semantic conventions are opted in
  - `gen_ai.request.model`, `gen_ai.operation.name`, `gen_ai.usage.*`

Plugin attribution is span-only. It does not add a plugin dimension to shared
OpenTelemetry metrics or change Prometheus metric labels.

- `afora.run`
  - `afora.outcome`, `afora.channel`, `afora.provider`, `afora.model`, `afora.errorCategory`
- `afora.model.call`
  - `gen_ai.system` by default, or `gen_ai.provider.name` when the latest GenAI semantic conventions are opted in
  - `gen_ai.request.model`, `gen_ai.operation.name`, `afora.provider`, `afora.model`, `afora.api`, `afora.transport`, `afora.model_call.observation_unit` (`request` or `turn`)
  - `afora.errorCategory`, `error.type`, and optional `afora.failureKind` on errors
  - `afora.model_call.request_bytes`, `afora.model_call.response_bytes`, `afora.model_call.time_to_first_byte_ms`
  - `afora.model_call.prompt.input_messages_count`, `afora.model_call.prompt.input_messages_chars`, `afora.model_call.prompt.system_prompt_chars`, `afora.model_call.prompt.tool_definitions_count`, `afora.model_call.prompt.tool_definitions_chars`, `afora.model_call.prompt.total_chars` (safe component sizes only, no prompt text)
  - `afora.model_call.usage.*` and `gen_ai.usage.*` when the result carries usage for that request or aggregate turn
  - Span event `afora.provider.request` with attribute `afora.upstreamRequestIdHash` (bounded, hash-based) when the upstream provider result exposes a request id; raw ids are never exported
  - With `OTEL_SEMCONV_STABILITY_OPT_IN=gen_ai_latest_experimental`, request spans use the latest GenAI inference span name `{gen_ai.operation.name} {gen_ai.request.model}`. Turn spans use `invoke_agent` because Afora does not claim a native agent name from the opaque CLI boundary. Both use `CLIENT` span kind instead of `afora.model.call`.
- `afora.harness.run`
  - `afora.harness.id`, `afora.harness.plugin`, `afora.outcome`, `afora.provider`, `afora.model`, `afora.channel`
  - On completion: `afora.harness.result_classification`, `afora.harness.yield_detected`, `afora.harness.items.started`, `afora.harness.items.completed`, `afora.harness.items.active`
  - On error: `afora.harness.phase`, `afora.errorCategory`, optional `afora.harness.cleanup_failed`
- `afora.tool.execution`
  - `gen_ai.tool.name`, `gen_ai.operation.name` (`execute_tool`), `afora.toolName`, `afora.tool.source`, optional `gen_ai.tool.call.id`, `afora.tool.owner`, `afora.tool.params.*`
  - Optional `afora.errorCategory`/`afora.errorCode` on errors, `afora.deniedReason` and `afora.outcome=blocked` when denied by policy or sandbox
- `afora.exec`
  - `afora.exec.target`, `afora.exec.mode`, `afora.outcome`, `afora.failureKind`, `afora.exec.command_length`, `afora.exec.exit_code`, `afora.exec.exit_signal`, `afora.exec.timed_out`
- `afora.webhook.processed`
  - `afora.channel`, `afora.webhook`
- `afora.webhook.error`
  - `afora.channel`, `afora.webhook`, `afora.error`
- `afora.message.processed`
  - `afora.channel`, `afora.outcome`, `afora.reason`
- `afora.message.delivery`
  - `afora.channel`, `afora.delivery.kind`, `afora.outcome`, `afora.errorCategory`, `afora.delivery.result_count`
- `afora.session.stuck`
  - `afora.state`, `afora.ageMs`, `afora.queueDepth`
- `afora.context.assembled`
  - `afora.prompt.size`, `afora.history.size`, `afora.context.tokens`, `afora.errorCategory` (no prompt, history, response, or session-key content)
- `afora.tool.loop`
  - `afora.toolName`, `afora.loop.level`, `afora.loop.action`, `afora.loop.detector`, `afora.loop.count`, optional `afora.loop.paired_tool` (no loop messages, params, or tool output)
- `afora.memory.pressure`
  - `afora.memory.level`, `afora.memory.reason`, `afora.memory.rss_bytes`, `afora.memory.heap_used_bytes`, `afora.memory.heap_total_bytes`, `afora.memory.external_bytes`, `afora.memory.array_buffers_bytes`, optional `afora.memory.threshold_bytes`/`afora.memory.rss_growth_bytes`/`afora.memory.window_ms`

When content capture is explicitly enabled, model and tool spans can also
include bounded, redacted `afora.content.*` attributes for the specific
content classes you opted into.

## Diagnostic event catalog

The events below back the metrics and spans above. Public events are also
available for direct plugin subscription; trusted core events such as
`model.usage` are restricted to authorized internal consumers.
`run.progress` and `run.execution_phase` are direct-only lifecycle signals;
the diagnostics-otel plugin does not export them as standalone OTLP signals.
Event kinds and `run.execution_phase.phase` values are additive. TypeScript
consumers should keep default branches instead of assuming either union is
permanently exhaustive.

**Model usage**

`model.usage` is a trusted, in-process diagnostic event, not a JSONL log
record. A representative event has this shape:

```json
{
  "type": "model.usage",
  "ts": 1735689600000,
  "seq": 42,
  "provider": "openai",
  "model": "gpt-5.4",
  "channel": "webchat",
  "agentId": "main",
  "sessionId": "session-123",
  "sessionKey": "agent:main:main",
  "usage": {
    "input": 120,
    "output": 40,
    "cacheRead": 30,
    "cacheWrite": 10,
    "promptTokens": 160,
    "total": 200
  },
  "lastCallUsage": {
    "input": 120,
    "output": 40,
    "cacheRead": 30,
    "cacheWrite": 10,
    "total": 200
  },
  "context": { "limit": 128000, "used": 160 },
  "costUsd": 0.0012,
  "durationMs": 850,
  "trace": {
    "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
    "spanId": "00f067aa0ba902b7",
    "traceFlags": "01"
  }
}
```

- `ts` is a Unix timestamp in milliseconds; `seq` is process-local.
- `usage` holds turn-level token counts. `promptTokens` includes `input`,
  `cacheRead`, and `cacheWrite`; `lastCallUsage`, when available, describes the
  final model call.
- `context.used` is the current prompt/context snapshot and can be lower than
  `usage.total` when cached input or tool-loop calls are involved.
- Provider/model/session identifiers, token buckets, `lastCallUsage`,
  `context`, `costUsd`, `durationMs`, and `trace` fields are optional.
  `costUsd` is an estimate and can be absent when model pricing is unavailable;
  it is not provider-reported billing. Trace context can also include
  `parentSpanId`.

The Gateway's `/tmp/AforaMosh/afora-agent-YYYY-MM-DD.log` JSONL file and
`diagnostics.otel.logsExporter: "stdout"` contain ordinary log records, not raw
`model.usage` events. Public diagnostic subscriptions and
`diagnostics.stability` do not expose trusted core usage events. The
diagnostics-otel plugin converts them to metrics such as `afora.tokens` and
`afora.cost.usd` and to `afora.model.usage` spans; those usage metrics
and spans intentionally omit session identifiers.

For an external integration that needs session-correlated usage, query the
authenticated Gateway instead:

```bash
afora gateway call sessions.usage --params '{"range":"30d","agentScope":"all"}' --json
afora gateway usage-cost --days 30 --all-agents --json
```

Both commands require `operator.read`. `sessions.usage` can include per-session
`sessionId`, provider/model details, and token/cost summaries; per-session usage
can be temporarily `null` while its cache refreshes. `usage-cost` provides
aggregate estimates. Omit `agentScope` or `--all-agents` to scope the report
to the default agent. For continuously updated clients,
[subscribe to session changes instead of polling usage reports](/gateway/clients#subscribe-instead-of-polling-usage).
See the [Gateway RPC method reference](/gateway/protocol#rpc-method-families)
for usage methods and request options.

**Message flow**

- `webhook.received` / `webhook.processed` / `webhook.error`
- `message.queued` / `message.processed`
- `message.delivery.started` / `message.delivery.completed` / `message.delivery.error`

**Queue and session**

- `queue.lane.enqueue` / `queue.lane.dequeue`
- `session.state` / `session.long_running` / `session.stalled` / `session.stuck`
- `run.attempt` / `run.progress`
- `run.execution_phase` (public, session-correlated embedded-runner startup milestones)
- `diagnostic.heartbeat` (aggregate counters: webhooks/queue/session)

**Harness lifecycle**

- `harness.run.started` / `harness.run.completed` / `harness.run.error` -
  per-run lifecycle for the agent harness. Includes `harnessId`, optional
  `pluginId`, provider/model/channel, and run id. Completion adds
  `durationMs`, `outcome`, optional `resultClassification`, `yieldDetected`,
  and `itemLifecycle` counts. Errors add `phase`
  (`prepare`/`start`/`send`/`resolve`/`cleanup`), `errorCategory`, and
  optional `cleanupFailed`.

**Exec**

- `exec.process.completed` - terminal outcome, duration, target, mode, exit
  code, and failure kind. Command text and working directories are not
  included.
- `exec.approval.followup_suppressed` - stale approval follow-up dropped
  after a session rebound. Includes `approvalId`, `reason`
  (`session_rebound`), `phase` (`direct_delivery` or `gateway_preflight`),
  and the dispatcher timestamp. Session keys, routes, and command text are
  not included.

## Without an exporter

Keep diagnostics events available to plugins or custom sinks without running
`diagnostics-otel`:

```json5
{
  diagnostics: { enabled: true },
}
```

For targeted debug output without raising `logging.level`, use diagnostics
flags. Flags are case-insensitive and support wildcards (`telegram.*` or
`*`):

```json5
{
  diagnostics: { flags: ["telegram.http"] },
}
```

Or as a one-off env override:

```bash
AFORA_DIAGNOSTICS=telegram.http,telegram.payload afora gateway
```

Flag output goes to the standard log file (`logging.file`) and is still
redacted by the always-on log redaction policy. Full guide:
[Diagnostics flags](/diagnostics/flags).

## Disable

```json5
{
  diagnostics: { otel: { enabled: false } },
}
```

Or leave `diagnostics-otel` out of `plugins.allow`, or run
`afora plugins disable diagnostics-otel`.

When the plugin would otherwise own NodeSDK, keep propagation available while
disabling every plugin-owned exporter, listener, health route, and stdout sink:

```bash
OTEL_SDK_DISABLED=true afora gateway
```

## Related

- [Logging](/logging) - file logs, console output, CLI tailing, and the Control UI Logs tab
- [Gateway logging internals](/gateway/logging) - WS log styles, subsystem prefixes, and console capture
- [Diagnostics flags](/diagnostics/flags) - targeted debug-log flags
- [Diagnostics export](/gateway/diagnostics) - operator support-bundle tool (separate from OTEL export)
- [Configuration reference](/gateway/configuration-reference#diagnostics) - full `diagnostics.*` field reference
