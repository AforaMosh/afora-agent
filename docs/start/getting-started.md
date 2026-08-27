---
summary: "Get Afora installed and run your first chat in minutes."
read_when:
  - First time setup from zero
  - You want the fastest path to a working chat
title: "Getting started"
---

Install Afora, run onboarding, and chat with your AI assistant in about 5
minutes. By the end you will have a running Gateway, configured auth, and a
working chat session.

## What you need

- **Node.js 22.22.3+, 24.15+, or 25.9+** (Node 26 is the recommended runtime)
- **An API key** from a model provider (Anthropic, OpenAI, Google, etc.) — onboarding will prompt you

<Tip>
Check your Node version with `node --version`.
**Windows users:** the native Windows Hub app is the easiest desktop path. The
PowerShell installer and WSL2 Gateway paths are also supported. See [Windows](/platforms/windows).
Need to install Node? See [Node setup](/install/node).
</Tip>

## Quick setup

<Steps>
  <Step title="Install Afora">
    <Tabs>
      <Tab title="macOS / Linux">
        ```bash
        curl -fsSL https://afora.ai/install.sh | bash
        ```
        <img
  src="/assets/install-script.svg"
  alt="Install Script Process"
  className="rounded-lg"
/>
      </Tab>
      <Tab title="Windows (PowerShell)">
        ```powershell
        iwr -useb https://afora.ai/install.ps1 | iex
        ```
      </Tab>
    </Tabs>

    <Note>
    Other install methods (Docker, Nix, npm): [Install](/install).
    </Note>

  </Step>
  <Step title="Complete onboarding">
    The installer starts the onboarding wizard automatically. Follow it to choose
    a model provider, set an API key, and configure the Gateway. QuickStart is
    usually only a few minutes, but provider sign-in, channel pairing, daemon
    install, network downloads, skills, or optional plugins can make full
    onboarding take longer. Skip optional steps and return later with
    `afora configure`.

    See [Onboarding (CLI)](/start/wizard) for the full reference.

  </Step>
  <Step title="Verify the Gateway is running">
    ```bash
    afora gateway status
    ```

    You should see the Gateway listening on port 18789.

  </Step>
  <Step title="Open the dashboard">
    ```bash
    afora dashboard
    ```

    This opens the Control UI in your browser. If it loads, everything is working.

  </Step>
  <Step title="Send your first message">
    Type a message in the Control UI chat and you should get an AI reply.

    Want to chat from your phone instead? The fastest channel to set up is
    [Telegram](/channels/telegram) (just a bot token). See [Channels](/channels)
    for all options.

  </Step>
</Steps>

<Accordion title="Advanced: mount a custom Control UI build">
  If you maintain a localized or customized dashboard build, point
  `gateway.controlUi.root` to a directory that contains your built static
  assets and `index.html`.

```bash
mkdir -p "$HOME/.afora/control-ui-custom"
# Copy your built static files into that directory.
```

Then set:

```json
{
  "gateway": {
    "controlUi": {
      "enabled": true,
      "root": "${HOME}/.afora/control-ui-custom"
    }
  }
}
```

Restart the gateway and reopen the dashboard:

```bash
afora gateway restart
afora dashboard
```

</Accordion>

## What to do next

<Columns>
  <Card title="Connect a channel" href="/channels" icon="message-square">
    Discord, Feishu, iMessage, Matrix, Microsoft Teams, Signal, Slack, Telegram, WhatsApp, Zalo, and more.
  </Card>
  <Card title="Pairing and safety" href="/channels/pairing" icon="shield">
    Control who can message your agent.
  </Card>
  <Card title="Configure the Gateway" href="/gateway/configuration" icon="settings">
    Models, tools, sandbox, and advanced settings.
  </Card>
  <Card title="Browse tools" href="/tools" icon="wrench">
    Browser, exec, web search, skills, and plugins.
  </Card>
</Columns>

<Accordion title="Advanced: environment variables">
  If you run Afora as a service account or want custom paths:

- `AFORA_HOME` — home directory for internal path resolution
- `AFORA_STATE_DIR` — override the state directory
- `AFORA_CONFIG_PATH` — override the config file path

Full reference: [Environment variables](/help/environment).
</Accordion>

## Related

- [Install overview](/install)
- [Channels overview](/channels)
- [Setup](/start/setup)
