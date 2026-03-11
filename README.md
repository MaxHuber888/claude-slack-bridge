# claude-slack-bridge

A lightweight bridge that connects a running [Claude Code](https://docs.anthropic.com/en/docs/claude-code) session to a private Slack channel, letting you send prompts and receive responses from your phone or any device — without needing to be at your terminal.

IMPORTANT: This project is built specifically for use with [MiniMax M2.5](https://platform.minimax.io) as a cost-efficient Claude Code backend.

---

## Why this exists

Claude Code's built-in remote control (`/rc`) requires an attached Anthropic account and won't work with third-party LLM providers. This bridge is a workaround: a small Node.js process that spawns `claude` as a subprocess and pipes messages to and from Slack in real time.

At MiniMax's published rates ($0.27/M input, $0.95/M output), this setup costs a fraction of running against Anthropic's API directly.

---

## Features

- 💬 Send prompts to Claude Code from any device via Slack
- 🔁 Persistent sessions — context is maintained across messages using `--resume`
- 🧵 Live intermediate updates (tool calls, thinking) streamed as Slack thread replies
- 💰 `/cost` — real-time token cost tracking at MiniMax rates
- 🔴 `/exit` — end session and print cost summary
- 🆕 `/new` — start a fresh session with cleared context
- 📋 `/rule` — set per-session guardrails (e.g. no git, no test runners)
- 🔔 Push notifications via Slack mobile when long tasks complete

---

## Prerequisites

- [Node.js](https://nodejs.org) v18 or later
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and working (`claude --version`)
- A [MiniMax API account](https://platform.minimax.io) with an API key
- A Slack workspace you control (a free personal org works fine)

---

## Setup

### 1. Clone and install

```bash
git clone https://github.com/yourusername/claude-slack-bridge
cd claude-slack-bridge
npm install
```

### 2. Create the Slack app

Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App → From a manifest** and paste the contents of [`slack-manifest.yaml`](./slack-manifest.yaml).

After creation, two manual steps are required:

**Generate an App-Level Token:**
Go to **Settings → Basic Information → App-Level Tokens → Generate Token**, add the `connections:write` scope, and copy the `xapp-` token into your `.env` file.

**Install to your workspace:**
Go to **OAuth & Permissions → Install to Workspace** and copy the `xoxb-` bot token into your `.env` file.

**Register slash commands:**
Go to **Features → Slash Commands** and create entries for `/cost`, `/exit`, `/new`, and `/rule`. No request URL is needed — Socket Mode handles delivery.

### 3. Configure environment

Copy the example env file and fill in your values:

```bash
cp .env.example .env
```

```bash
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
SLACK_CHANNEL_ID=G...
ANTHROPIC_BASE_URL=https://api.minimaxi.chat/v1
ANTHROPIC_API_KEY=your-minimax-key
```

### 4. Invite the bot to your channel

In Slack, open your private channel and run `/invite @claude-bridge`.

---

## Usage

Navigate to the project you want to work in, then start the bridge:

```bash
cd ~/projects/my-app
node /path/to/claude-slack-bridge/bridge.cjs
```

Or add a shell alias to your `.zshrc` / `.bashrc` for convenience:

```bash
alias cb="node ~/tools/claude-slack-bridge/bridge.cjs"
```

Then simply:

```bash
cd ~/projects/my-app
cb
```

The bridge will post a startup message to your Slack channel confirming the active project directory. From there, any message you send in the channel is forwarded to Claude Code.

---

## Slash commands

| Command | Description |
|---|---|
| `/cost` | Show token usage and estimated cost for the current session |
| `/exit` | End the session and display a final cost summary |
| `/new` | Clear session context and start fresh |
| `/rule list` | Show active session rules |
| `/rule add <key>` | Add a guardrail rule |
| `/rule remove <key>` | Remove a rule |
| `/rule clear` | Remove all rules |

### Available rules

| Key | Effect |
|---|---|
| `git` | No git commands |
| `test` | No test runners |
| `dev` | No dev servers or watch processes |
| `lint` | No linters or formatters |
| `install` | No package installs |

Rules are prepended to every prompt in the session and reset when you run `/exit` or `/new`.

---

## A note on `--dangerously-skip-permissions`

This bridge runs Claude Code with the `--dangerously-skip-permissions` flag. This is required because Claude Code is spawned as a headless subprocess with no interactive terminal, so it cannot prompt you for confirmation before making file edits or running commands.

**What this means in practice:** Claude will make file changes and run shell commands without asking first. This is the same trust level as running `claude` interactively and approving everything. Only run this bridge pointed at projects and directories you're comfortable with Claude having full access to.

---

## How sessions work

Each project directory gets its own session ID, captured from Claude Code's JSON output on the first message. Subsequent messages use `--resume <session-id>` so Claude maintains full context — file edits, tool calls, conversation history — across turns.

Sessions are scoped to the lifetime of the bridge process. Restarting the bridge starts a new session.

---

## Limitations

- **No parallel requests** — if you send a second message while Claude is still processing the first, it will queue and run sequentially
- **5 minute timeout** — long-running tasks will be killed after 5 minutes; adjust `setTimeout` in `bridge.cjs` if needed
- **Cost tracking resets on restart** — session usage is in-memory only
- **MiniMax only** — this project is intentionally scoped to MiniMax M2.5 via Claude Code's `ANTHROPIC_BASE_URL` substitution

---

## Contributing

This project is intentionally kept small and focused: a Slack bridge for Claude Code using MiniMax. Feature PRs that expand the scope (other LLM providers, other chat platforms, web UIs) are unlikely to be merged, but issues and bug fixes are very welcome.

---

## License

MIT
