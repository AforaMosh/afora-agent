---
summary: "Generated inventory of Afora plugins shipped in core, published externally, or kept source-only"
read_when:
  - You are deciding whether a plugin ships in the core npm package or installs separately
  - You are updating bundled plugin package metadata or release automation
  - You need the canonical internal vs external plugin list
title: "Plugin inventory"
---

# Plugin inventory

This page is generated from top-level `extensions/*/afora.plugin.json`
manifests and the root npm package `files` exclusions. Optional `package.json`
metadata enriches package and distribution details. Regenerate it with:

```bash
pnpm plugins:inventory:gen
```

## Definitions

- **Core npm package:** built into the `afora` npm package and available without a separate plugin install.
- **Official external package:** Afora-maintained plugin omitted from the core npm package, kept in this official inventory, and installed on demand through ClawHub and/or npm.
- **Source checkout only:** repo-local plugin omitted from published npm artifacts and not advertised as an installable package.

Source checkouts are different from npm installs: after `pnpm install`, bundled
plugins load from `extensions/<id>` so local edits and package-local workspace
dependencies are available.

## Install a plugin

Use the install route in each entry to decide whether install is needed. Plugins
that say `included in Afora` are already present in the core package.
Official external packages need one install, then a Gateway restart.

For example, Discord is an official external package:

```bash
afora plugins install @afora/discord
afora gateway restart
afora plugins inspect discord --runtime --json
```

During the launch cutover, ordinary bare package specs still install from npm.
Use `clawhub:@afora/discord` or `npm:@afora/discord` when you need an
explicit source. After install, follow the plugin's setup doc, such as
[Discord](/channels/discord), to add credentials and channel config. See
[Manage plugins](/plugins/manage-plugins) for update, uninstall, and publishing
commands.

Each entry lists the package, distribution route, and description.

## Core npm package

58 plugins

- **[active-memory](/plugins/reference/active-memory)** (`afora`) - included in Afora. Runs bounded pre-reply memory retrieval and implements per-agent Remember across conversations for eligible private conversations.

- **[admin-http-rpc](/plugins/reference/admin-http-rpc)** (`@afora/admin-http-rpc`) - included in Afora. Afora admin HTTP RPC endpoint.

- **[alibaba](/plugins/reference/alibaba)** (`@afora/alibaba-provider`) - included in Afora. Adds video generation provider support.

- **[anthropic](/plugins/reference/anthropic)** (`@afora/anthropic-provider`) - included in Afora. Anthropic models, Claude CLI, and native Claude session catalog.

- **[azure-speech](/plugins/reference/azure-speech)** (`@afora/azure-speech`) - included in Afora. Azure AI Speech text-to-speech (MP3, native Ogg/Opus voice notes, PCM telephony).

- **[beam](/plugins/reference/beam)** (`@afora/beam`) - included in Afora. Read-only coding-session Beam receiver.

- **[bonjour](/plugins/reference/bonjour)** (`@afora/bonjour`) - included in Afora. Advertise the local Afora gateway over Bonjour/mDNS.

- **[browser](/plugins/reference/browser)** (`@afora/browser-plugin`) - included in Afora. Adds agent-callable tools.

- **[canvas](/plugins/reference/canvas)** (`@afora/canvas-plugin`) - included in Afora. Experimental Canvas control and A2UI rendering surfaces for paired nodes.

- **[clawrouter](/plugins/reference/clawrouter)** (`@afora/clawrouter`) - included in Afora. Adds ClawRouter model provider support to Afora.

- **[copilot-proxy](/plugins/reference/copilot-proxy)** (`@afora/copilot-proxy`) - included in Afora. Adds Copilot Proxy model provider support to Afora.

- **[crabbox](/plugins/reference/crabbox)** (`@afora/crabbox-provider`) - included in Afora. Cloud worker provider backed by the Crabbox CLI.

- **[cua-computer](/plugins/reference/cua-computer)** (`@afora/cua-computer`) - included in Afora. Experimental CUA Driver SDK computer control for Windows and Linux node hosts.

- **[deepgram](/plugins/reference/deepgram)** (`@afora/deepgram-provider`) - included in Afora. Adds media understanding provider support. Adds realtime transcription provider support.

- **[device-pair](/plugins/reference/device-pair)** (`afora`) - included in Afora. Generate setup codes and approve device pairing requests.

- **[document-extract](/plugins/reference/document-extract)** (`@afora/document-extract-plugin`) - included in Afora. Extract text and fallback page images from local document attachments.

- **[elevenlabs](/plugins/reference/elevenlabs)** (`@afora/elevenlabs-speech`) - included in Afora. Adds media understanding provider support. Adds realtime transcription provider support. Adds text-to-speech provider support.

- **[fal](/plugins/reference/fal)** (`@afora/fal-provider`) - included in Afora. Adds fal model provider support to Afora.

- **[file-transfer](/plugins/reference/file-transfer)** (`@afora/file-transfer`) - included in Afora. Fetch, list, and write files on paired nodes via dedicated node commands. Bypasses bash stdout truncation by using base64 over node.invoke for binaries up to 16 MB.

- **[github-copilot](/plugins/reference/github-copilot)** (`@afora/github-copilot-provider`) - included in Afora. Adds GitHub Copilot model provider support to Afora.

- **[google](/plugins/reference/google)** (`@afora/google-plugin`) - included in Afora. Adds Google, Google Gemini CLI, Google Vertex model provider support to Afora.

- **[huggingface](/plugins/reference/huggingface)** (`@afora/huggingface-provider`) - included in Afora. Adds Hugging Face model provider support to Afora.

- **[linux-canvas](/plugins/reference/linux-canvas)** (`@afora/linux-canvas`) - included in Afora. Canvas rendering bridge for the Afora Linux desktop app.

- **[linux-node](/plugins/reference/linux-node)** (`@afora/linux-node`) - included in Afora. Desktop notifications, camera capture, and location for Linux node hosts.

- **[litellm](/plugins/reference/litellm)** (`@afora/litellm-provider`) - included in Afora. Adds LiteLLM model provider support to Afora.

- **[llm-task](/plugins/reference/llm-task)** (`@afora/llm-task`) - included in Afora. Generic JSON-only LLM tool for structured tasks callable from workflows.

- **[lmstudio](/plugins/reference/lmstudio)** (`@afora/lmstudio-provider`) - included in Afora. Adds LM Studio model provider support to Afora.

- **[logbook](/plugins/reference/logbook)** (`@afora/logbook`) - included in Afora. Automatic work journal: captures periodic screen snapshots from a paired node and turns them into a reviewable timeline of your day.

- **[memory-core](/plugins/reference/memory-core)** (`@afora/memory-core`) - included in Afora. Adds agent-callable tools.

- **[memory-wiki](/plugins/reference/memory-wiki)** (`@afora/memory-wiki`) - included in Afora. Persistent wiki compiler and Obsidian-friendly knowledge vault for Afora.

- **[microsoft](/plugins/reference/microsoft)** (`@afora/microsoft-speech`) - included in Afora. Adds text-to-speech provider support.

- **[microsoft-foundry](/plugins/reference/microsoft-foundry)** (`@afora/microsoft-foundry`) - included in Afora. Adds Microsoft Foundry model provider support to Afora.

- **[migrate-claude](/plugins/reference/migrate-claude)** (`@afora/migrate-claude`) - included in Afora. Imports Claude Code and Claude Desktop instructions, MCP servers, skills, and safe configuration into Afora.

- **[migrate-hermes](/plugins/reference/migrate-hermes)** (`@afora/migrate-hermes`) - included in Afora. Imports Hermes configuration, memories, skills, and supported credentials into Afora.

- **[minimax](/plugins/reference/minimax)** (`@afora/minimax-provider`) - included in Afora. Adds MiniMax, MiniMax Portal model provider support to Afora.

- **[nvidia](/plugins/reference/nvidia)** (`@afora/nvidia-provider`) - included in Afora. Adds NVIDIA model provider support to Afora.

- **[oc-path](/plugins/reference/oc-path)** (`@afora/oc-path`) - included in Afora. Adds the afora path CLI for oc:// workspace file addressing.

- **[ollama](/plugins/reference/ollama)** (`@afora/ollama-provider`) - included in Afora. Adds Ollama, Ollama Cloud model provider support to Afora.

- **[onepassword](/plugins/reference/onepassword)** (`@afora/onepassword`) - included in Afora. 1Password SecretRef resolver and curated agent broker with approval policy and SQLite audit history.

- **[open-prose](/plugins/reference/open-prose)** (`@afora/open-prose`) - included in Afora. OpenProse VM skill pack with a /prose slash command.

- **[openai](/plugins/reference/openai)** (`@afora/openai-provider`) - included in Afora. Adds OpenAI model provider support to Afora.

- **[opencode-go](/plugins/reference/opencode-go)** (`@afora/opencode-go-provider`) - included in Afora. Adds OpenCode Go model provider support to Afora.

- **[openrouter](/plugins/reference/openrouter)** (`@afora/openrouter-provider`) - included in Afora. Adds OpenRouter model provider support to Afora.

- **[policy](/plugins/reference/policy)** (`@afora/policy`) - included in Afora. Adds policy-backed doctor checks for workspace conformance.

- **[reef](/plugins/reference/reef)** (`@afora/reef`) - included in Afora. Guarded end-to-end encrypted claw channel.

- **[runway](/plugins/reference/runway)** (`@afora/runway-provider`) - included in Afora. Adds video generation provider support.

- **[senseaudio](/plugins/reference/senseaudio)** (`@afora/senseaudio-provider`) - included in Afora. Adds media understanding provider support.

- **[sglang](/plugins/reference/sglang)** (`@afora/sglang-provider`) - included in Afora. Adds SGLang model provider support to Afora.

- **[talk-voice](/plugins/reference/talk-voice)** (`afora`) - included in Afora. Manage Talk voice selection (list/set).

- **[telegram](/plugins/reference/telegram)** (`@afora/telegram`) - included in Afora. Adds the Telegram channel surface for sending and receiving Afora messages.

- **[together](/plugins/reference/together)** (`@afora/together-provider`) - included in Afora. Adds Together model provider support to Afora.

- **[tts-local-cli](/plugins/reference/tts-local-cli)** (`@afora/tts-local-cli`) - included in Afora. Adds text-to-speech provider support.

- **[vault](/plugins/reference/vault)** (`@afora/vault`) - included in Afora. HashiCorp Vault SecretRef provider integration.

- **[vllm](/plugins/reference/vllm)** (`@afora/vllm-provider`) - included in Afora. Adds vLLM model provider support to Afora.

- **[web-readability](/plugins/reference/web-readability)** (`@afora/web-readability-plugin`) - included in Afora. Extract readable article content from local HTML web fetch responses.

- **[webhooks](/plugins/reference/webhooks)** (`@afora/webhooks`) - included in Afora. Authenticated inbound webhooks that bind external automation to Afora TaskFlows.

- **[workboard](/plugins/reference/workboard)** (`@afora/workboard`) - included in Afora. Dashboard workboard for agent-owned issues and sessions.

- **[xai](/plugins/reference/xai)** (`@afora/xai-plugin`) - included in Afora. Adds xAI model provider support to Afora.

## Official external packages

90 plugins

- **[acpx](/plugins/reference/acpx)** (`@afora/acpx`) - npm; ClawHub. Afora ACP runtime backend with plugin-owned session and transport management.

- **[amazon-bedrock](/plugins/reference/amazon-bedrock)** (`@afora/amazon-bedrock-provider`) - npm; ClawHub. Afora Amazon Bedrock provider plugin with model discovery, embeddings, and guardrail support.

- **[amazon-bedrock-mantle](/plugins/reference/amazon-bedrock-mantle)** (`@afora/amazon-bedrock-mantle-provider`) - npm; ClawHub. Afora Amazon Bedrock Mantle provider plugin for OpenAI-compatible model routing.

- **[anthropic-vertex](/plugins/reference/anthropic-vertex)** (`@afora/anthropic-vertex-provider`) - npm; ClawHub. Afora Anthropic Vertex provider plugin for Claude models on Google Vertex AI.

- **[arcee](/plugins/reference/arcee)** (`@afora/arcee-provider`) - npm; ClawHub: `clawhub:@afora/arcee-provider`. Adds Arcee model provider support to Afora.

- **[baseten](/plugins/reference/baseten)** (`@afora/baseten-provider`) - npm; ClawHub: `clawhub:@afora/baseten-provider`. Afora Baseten provider plugin.

- **[brave](/plugins/reference/brave)** (`@afora/brave-plugin`) - npm; ClawHub. Afora Brave Search provider plugin for web search.

- **[buzz](/plugins/reference/buzz)** (`@afora/buzz`) - npm; ClawHub: `clawhub:@afora/buzz`. Connect Afora agents to Buzz rooms.

- **[byteplus](/plugins/reference/byteplus)** (`@afora/byteplus-provider`) - npm; ClawHub: `clawhub:@afora/byteplus-provider`. Adds BytePlus, BytePlus Plan model provider support to Afora.

- **[cerebras](/plugins/reference/cerebras)** (`@afora/cerebras-provider`) - npm; ClawHub: `clawhub:@afora/cerebras-provider`. Adds Cerebras model provider support to Afora.

- **[chutes](/plugins/reference/chutes)** (`@afora/chutes-provider`) - npm; ClawHub: `clawhub:@afora/chutes-provider`. Adds Chutes model provider support to Afora.

- **[clickclack](/plugins/reference/clickclack)** (`@afora/clickclack`) - npm; ClawHub: `clawhub:@afora/clickclack`. Adds the Clickclack channel surface for sending and receiving Afora messages.

- **[cloudflare-ai-gateway](/plugins/reference/cloudflare-ai-gateway)** (`@afora/cloudflare-ai-gateway-provider`) - npm; ClawHub: `clawhub:@afora/cloudflare-ai-gateway-provider`. Adds Cloudflare AI Gateway model provider support to Afora.

- **[codex](/plugins/reference/codex)** (`@afora/codex`) - npm; ClawHub. Codex app-server harness and native session catalog.

- **[cohere](/plugins/reference/cohere)** (`@afora/cohere-provider`) - npm; ClawHub: `clawhub:@afora/cohere-provider`. Afora Cohere provider plugin.

- **[comfy](/plugins/reference/comfy)** (`@afora/comfy-provider`) - npm; ClawHub: `clawhub:@afora/comfy-provider`. Adds ComfyUI model provider support to Afora.

- **[copilot](/plugins/reference/copilot)** (`@afora/copilot`) - npm; ClawHub: `clawhub:@afora/copilot`. Registers the GitHub Copilot agent runtime.

- **[deepinfra](/plugins/reference/deepinfra)** (`@afora/deepinfra-provider`) - npm; ClawHub: `clawhub:@afora/deepinfra-provider`. Adds DeepInfra model provider support to Afora.

- **[deepseek](/plugins/reference/deepseek)** (`@afora/deepseek-provider`) - npm; ClawHub: `clawhub:@afora/deepseek-provider`. Adds DeepSeek model provider support to Afora.

- **[diagnostics-otel](/plugins/reference/diagnostics-otel)** (`@afora/diagnostics-otel`) - npm; ClawHub: `clawhub:@afora/diagnostics-otel`. Afora diagnostics OpenTelemetry exporter for metrics, traces, and logs.

- **[diagnostics-prometheus](/plugins/reference/diagnostics-prometheus)** (`@afora/diagnostics-prometheus`) - npm; ClawHub: `clawhub:@afora/diagnostics-prometheus`. Afora diagnostics Prometheus exporter for runtime metrics.

- **[diffs](/plugins/reference/diffs)** (`@afora/diffs`) - npm; ClawHub. Afora read-only diff viewer plugin and file renderer for agents.

- **[diffs-language-pack](/plugins/reference/diffs-language-pack)** (`@afora/diffs-language-pack`) - npm; ClawHub: `clawhub:@afora/diffs-language-pack`. Adds syntax highlighting for languages outside the default diffs viewer set.

- **[discord](/plugins/reference/discord)** (`@afora/discord`) - npm; ClawHub. Afora Discord channel plugin for channels, DMs, commands, and app events.

- **[duckduckgo](/plugins/reference/duckduckgo)** (`@afora/duckduckgo-plugin`) - npm; ClawHub: `clawhub:@afora/duckduckgo-plugin`. Adds web search provider support.

- **[exa](/plugins/reference/exa)** (`@afora/exa-plugin`) - npm; ClawHub: `clawhub:@afora/exa-plugin`. Adds web search provider support.

- **[featherless](/plugins/reference/featherless)** (`@afora/featherless-provider`) - npm; ClawHub: `clawhub:@afora/featherless-provider`. Afora Featherless AI provider plugin.

- **[feishu](/plugins/reference/feishu)** (`@afora/feishu`) - npm; ClawHub. Afora Feishu/Lark channel plugin for chats and workplace tools (community maintained by @m1heng).

- **[firecrawl](/plugins/reference/firecrawl)** (`@afora/firecrawl-plugin`) - npm; ClawHub: `clawhub:@afora/firecrawl-plugin`. Adds agent-callable tools. Adds web fetch provider support. Adds web search provider support.

- **[fireworks](/plugins/reference/fireworks)** (`@afora/fireworks-provider`) - npm; ClawHub: `clawhub:@afora/fireworks-provider`. Adds Fireworks model provider support to Afora.

- **[fish-audio-speech](/plugins/reference/fish-audio-speech)** (`@afora/fish-audio-speech`) - npm; ClawHub: `clawhub:@afora/fish-audio-speech`. Fish Audio S2.1 hosted text-to-speech with streaming, voice notes, and telephony output.

- **[gmi](/plugins/reference/gmi)** (`@afora/gmi-provider`) - npm; ClawHub: `clawhub:@afora/gmi-provider`. Afora GMI Cloud provider plugin.

- **[google-meet](/plugins/reference/google-meet)** (`@afora/google-meet`) - npm; ClawHub. Afora Google Meet participant plugin for joining calls through Chrome or Twilio transports.

- **[googlechat](/plugins/reference/googlechat)** (`@afora/googlechat`) - npm; ClawHub. Afora Google Chat channel plugin for spaces and direct messages.

- **[gradium](/plugins/reference/gradium)** (`@afora/gradium-speech`) - npm; ClawHub: `clawhub:@afora/gradium-speech`. Adds text-to-speech provider support.

- **[groq](/plugins/reference/groq)** (`@afora/groq-provider`) - npm; ClawHub: `clawhub:@afora/groq-provider`. Adds Groq model provider support to Afora.

- **[imessage](/plugins/reference/imessage)** (`@afora/imessage`) - npm; ClawHub: `clawhub:@afora/imessage`. Adds the iMessage channel surface for sending and receiving Afora messages.

- **[inworld](/plugins/reference/inworld)** (`@afora/inworld-speech`) - npm; ClawHub: `clawhub:@afora/inworld-speech`. Inworld streaming text-to-speech (MP3, OGG_OPUS, PCM telephony).

- **[irc](/plugins/reference/irc)** (`@afora/irc`) - npm; ClawHub: `clawhub:@afora/irc`. Adds the IRC channel surface for sending and receiving Afora messages.

- **[kilocode](/plugins/reference/kilocode)** (`@afora/kilocode-provider`) - npm; ClawHub: `clawhub:@afora/kilocode-provider`. Adds Kilocode model provider support to Afora.

- **[kimi](/plugins/reference/kimi)** (`@afora/kimi-provider`) - npm; ClawHub: `clawhub:@afora/kimi-provider`. Adds Kimi, Kimi Coding model provider support to Afora.

- **[line](/plugins/reference/line)** (`@afora/line`) - npm; ClawHub. Afora LINE channel plugin for LINE Bot API chats.

- **[llama-cpp](/plugins/reference/llama-cpp)** (`@afora/llama-cpp-provider`) - npm; ClawHub. Managed local llama.cpp server for GGUF chat and embeddings.

- **[lobster](/plugins/reference/lobster)** (`@afora/lobster`) - npm; ClawHub. Lobster workflow tool plugin for typed pipelines and resumable approvals.

- **[longcat](/plugins/reference/longcat)** (`@afora/longcat-provider`) - npm; ClawHub: `clawhub:@afora/longcat-provider`. Afora LongCat provider plugin.

- **[matrix](/plugins/reference/matrix)** (`@afora/matrix`) - ClawHub: `clawhub:@afora/matrix`; npm. Afora Matrix channel plugin for rooms and direct messages.

- **[mattermost](/plugins/reference/mattermost)** (`@afora/mattermost`) - npm; ClawHub: `clawhub:@afora/mattermost`. Adds the Mattermost channel surface for sending and receiving Afora messages.

- **[memory-lancedb](/plugins/reference/memory-lancedb)** (`@afora/memory-lancedb`) - npm; ClawHub. Afora LanceDB-backed long-term memory plugin with auto-recall, auto-capture, and vector search.

- **[meta](/plugins/reference/meta)** (`@afora/meta-provider`) - npm; ClawHub: `clawhub:@afora/meta-provider`. Adds Meta model provider support to Afora.

- **[mistral](/plugins/reference/mistral)** (`@afora/mistral-provider`) - npm; ClawHub: `clawhub:@afora/mistral-provider`. Adds Mistral model provider support to Afora.

- **[moonshot](/plugins/reference/moonshot)** (`@afora/moonshot-provider`) - npm; ClawHub: `clawhub:@afora/moonshot-provider`. Adds Moonshot model provider support to Afora.

- **[msteams](/plugins/reference/msteams)** (`@afora/msteams`) - npm; ClawHub. Afora Microsoft Teams channel plugin for bot conversations.

- **[mxc](/plugins/reference/mxc)** (`@afora/mxc-sandbox`) - npm; ClawHub. OS-level sandboxed tool execution via MXC: runs commands in a Windows ProcessContainer with configured MXC policy files.

- **[nextcloud-talk](/plugins/reference/nextcloud-talk)** (`@afora/nextcloud-talk`) - npm; ClawHub. Afora Nextcloud Talk channel plugin for conversations.

- **[nostr](/plugins/reference/nostr)** (`@afora/nostr`) - npm; ClawHub. Afora Nostr channel plugin for NIP-04 encrypted direct messages.

- **[novita](/plugins/reference/novita)** (`@afora/novita-provider`) - npm; ClawHub: `clawhub:@afora/novita-provider`. Adds Novita, Novita AI, Novitaai model provider support to Afora.

- **[opencode](/plugins/reference/opencode)** (`@afora/opencode-provider`) - npm; ClawHub: `clawhub:@afora/opencode-provider`. Adds OpenCode model provider support to Afora.

- **[openshell](/plugins/reference/openshell)** (`@afora/openshell-sandbox`) - npm; ClawHub. Afora sandbox backend for the NVIDIA OpenShell CLI with mirrored local workspaces and SSH command execution.

- **[parallel](/tools/parallel-search)** (`@afora/parallel-plugin`) - npm; ClawHub: `clawhub:@afora/parallel-plugin`. Adds web search provider support.

- **[perplexity](/plugins/reference/perplexity)** (`@afora/perplexity-plugin`) - npm; ClawHub: `clawhub:@afora/perplexity-plugin`. Adds web search provider support.

- **[pixverse](/plugins/reference/pixverse)** (`@afora/pixverse-provider`) - npm; ClawHub: `clawhub:@afora/pixverse-provider`. Afora PixVerse video generation provider plugin.

- **[qianfan](/plugins/reference/qianfan)** (`@afora/qianfan-provider`) - npm; ClawHub: `clawhub:@afora/qianfan-provider`. Adds Qianfan model provider support to Afora.

- **[qqbot](/plugins/reference/qqbot)** (`@tencent-connect/afora-qqbot`) - npm. Afora QQ Bot channel plugin for group and direct-message workflows.

- **[qwen](/plugins/reference/qwen)** (`@afora/qwen-provider`) - npm; ClawHub: `clawhub:@afora/qwen-provider`. Adds Qwen, Qwen Cloud, Model Studio, DashScope, Qwen Token Plan, Bailian Token Plan model provider support to Afora.

- **[raft](/plugins/reference/raft)** (`@afora/raft`) - npm; ClawHub. Afora Raft channel plugin for secure CLI wake bridges.

- **[searxng](/plugins/reference/searxng)** (`@afora/searxng-plugin`) - npm; ClawHub: `clawhub:@afora/searxng-plugin`. Adds web search provider support.

- **[signal](/plugins/reference/signal)** (`@afora/signal`) - npm; ClawHub: `clawhub:@afora/signal`. Adds the Signal channel surface for sending and receiving Afora messages.

- **[slack](/plugins/reference/slack)** (`@afora/slack`) - npm; ClawHub. Afora Slack channel plugin for channels, DMs, commands, and app events.

- **[sms](/plugins/reference/sms)** (`@afora/sms`) - npm; ClawHub: `clawhub:@afora/sms`. Twilio SMS/MMS channel plugin for Afora messages.

- **[stepfun](/plugins/reference/stepfun)** (`@afora/stepfun-provider`) - npm; ClawHub: `clawhub:@afora/stepfun-provider`. Adds StepFun, StepFun Plan model provider support to Afora.

- **[synology-chat](/plugins/reference/synology-chat)** (`@afora/synology-chat`) - npm; ClawHub. Synology Chat channel plugin for Afora channels and direct messages.

- **[synthetic](/plugins/reference/synthetic)** (`@afora/synthetic-provider`) - npm; ClawHub: `clawhub:@afora/synthetic-provider`. Adds Synthetic model provider support to Afora.

- **[tavily](/plugins/reference/tavily)** (`@afora/tavily-plugin`) - npm; ClawHub: `clawhub:@afora/tavily-plugin`. Adds agent-callable tools. Adds web search provider support.

- **[teams-meetings](/plugins/reference/teams-meetings)** (`@afora/teams-meetings`) - npm; ClawHub: `clawhub:@afora/teams-meetings`. Join Microsoft Teams meetings as a Chrome browser guest.

- **[tencent](/plugins/reference/tencent)** (`@afora/tencent-provider`) - npm; ClawHub: `clawhub:@afora/tencent-provider`. Adds Tencent TokenHub, Tencent Tokenplan model provider support to Afora.

- **[tlon](/plugins/reference/tlon)** (`@afora/tlon`) - npm; ClawHub. Afora Tlon/Urbit channel plugin for chat workflows.

- **[tokenjuice](/plugins/reference/tokenjuice)** (`@afora/tokenjuice`) - npm; ClawHub: `clawhub:@afora/tokenjuice`. Compacts exec and bash tool results with tokenjuice reducers.

- **[twitch](/plugins/reference/twitch)** (`@afora/twitch`) - npm; ClawHub. Afora Twitch channel plugin for chat and moderation workflows.

- **[venice](/plugins/reference/venice)** (`@afora/venice-provider`) - npm; ClawHub: `clawhub:@afora/venice-provider`. Adds Venice model provider support to Afora.

- **[vercel-ai-gateway](/plugins/reference/vercel-ai-gateway)** (`@afora/vercel-ai-gateway-provider`) - npm; ClawHub: `clawhub:@afora/vercel-ai-gateway-provider`. Adds Vercel AI Gateway model provider support to Afora.

- **[voice-call](/plugins/reference/voice-call)** (`@afora/voice-call`) - npm; ClawHub. Afora voice-call plugin for Twilio, Telnyx, and Plivo phone calls.

- **[volcengine](/plugins/reference/volcengine)** (`@afora/volcengine-provider`) - npm; ClawHub: `clawhub:@afora/volcengine-provider`. Adds Volcengine, Volcengine Plan model provider support to Afora.

- **[voyage](/plugins/reference/voyage)** (`@afora/voyage-provider`) - npm; ClawHub: `clawhub:@afora/voyage-provider`. Adds embedding provider support, including memory search.

- **[vydra](/plugins/reference/vydra)** (`@afora/vydra-provider`) - npm; ClawHub: `clawhub:@afora/vydra-provider`. Adds Vydra model provider support to Afora.

- **[whatsapp](/plugins/reference/whatsapp)** (`@afora/whatsapp`) - ClawHub: `clawhub:@afora/whatsapp`; npm. Afora WhatsApp channel plugin for WhatsApp Web chats.

- **[xiaomi](/plugins/reference/xiaomi)** (`@afora/xiaomi-provider`) - npm; ClawHub: `clawhub:@afora/xiaomi-provider`. Adds Xiaomi, Xiaomi Token Plan model provider support to Afora.

- **[zai](/plugins/reference/zai)** (`@afora/zai-provider`) - npm; ClawHub: `clawhub:@afora/zai-provider`. Adds Z.AI model provider support to Afora.

- **[zalo](/plugins/reference/zalo)** (`@afora/zalo`) - npm; ClawHub. Afora Zalo channel plugin for bot and webhook chats.

- **[zalouser](/plugins/reference/zalouser)** (`@afora/zalouser`) - npm; ClawHub. Afora Zalo Personal Account plugin via native zca-js integration.

- **[zoom-meetings](/plugins/reference/zoom-meetings)** (`@afora/zoom-meetings`) - npm; ClawHub: `clawhub:@afora/zoom-meetings`. Join Zoom meetings as a Chrome browser guest.

## Source checkout only

2 plugins

- **[qa-channel](/plugins/reference/qa-channel)** (`@afora/qa-channel`) - source checkout only. Adds the QA Channel surface for sending and receiving Afora messages.

- **[qa-lab](/plugins/reference/qa-lab)** (`@afora/qa-lab`) - source checkout only. Afora QA lab plugin with private debugger UI and scenario runner.
