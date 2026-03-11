require("dotenv").config();
const { App } = require("@slack/bolt");
const { spawn } = require("child_process");

// ============================================================================
// Configuration
// ============================================================================

const PROJECT_DIR = process.cwd();

// MiniMax M2.5 pricing (per 1M tokens)
const MINIMAX_INPUT_COST_PER_M = 0.27;
const MINIMAX_OUTPUT_COST_PER_M = 0.95;

// Available session rules that users can enable via /rule command
const RULE_DEFINITIONS = {
	git: "Do not run any git commands (no git commit, push, pull, branch, stash, etc.).",
	test: "Do not run any test commands or test suites (no npm test, pytest, jest, mocha, etc.).",
	dev: "Do not start any development servers or watch processes (no npm run dev, vite, webpack --watch, etc.).",
	lint: "Do not run any linters or formatters automatically (no eslint, prettier, black, etc.).",
	install: "Do not install any new packages or dependencies (no npm install, pip install, brew install, etc.).",
};

// ============================================================================
// State Management
// ============================================================================

// Per-project state: session_id, usage, rules
// Format: { "/path": { sessionId, inputTokens, outputTokens, rules: Set } }
const projectSessions = new Map();

function getProjectState() {
	if (!projectSessions.has(PROJECT_DIR)) {
		projectSessions.set(PROJECT_DIR, {
			sessionId: null,
			inputTokens: 0,
			outputTokens: 0,
			rules: new Set(),
		});
	}
	return projectSessions.get(PROJECT_DIR);
}

function clearProjectState() {
	projectSessions.set(PROJECT_DIR, {
		sessionId: null,
		inputTokens: 0,
		outputTokens: 0,
		rules: new Set(),
	});
}

// ============================================================================
// Slack App Setup
// ============================================================================

const app = new App({
	token: process.env.SLACK_BOT_TOKEN,
	appToken: process.env.SLACK_APP_TOKEN,
	socketMode: true,
});

console.log("⚡ Claude bridge starting...");
console.log("📁 Project directory:", PROJECT_DIR);

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Builds the prompt by prepending session rules if any are active
 */
function buildPrompt(userPrompt) {
	const { rules } = getProjectState();
	if (rules.size === 0) return userPrompt;

	const ruleLines = [...rules]
		.map((r) => `- ${RULE_DEFINITIONS[r]}`)
		.join("\n");

	return `[Session rules — follow these for the entire session:\n${ruleLines}]\n\n${userPrompt}`;
}

/**
 * Calculates and formats the cost summary for the current session
 */
function costSummary(state) {
	const inputCost = (state.inputTokens / 1_000_000) * MINIMAX_INPUT_COST_PER_M;
	const outputCost = (state.outputTokens / 1_000_000) * MINIMAX_OUTPUT_COST_PER_M;
	const totalCost = inputCost + outputCost;

	return [
		"💰 *Session cost (MiniMax M2.5)*",
		`• Input:  ${state.inputTokens.toLocaleString()} tokens — $${inputCost.toFixed(4)}`,
		`• Output: ${state.outputTokens.toLocaleString()} tokens — $${outputCost.toFixed(4)}`,
		`• *Total: $${totalCost.toFixed(4)}*`,
	].join("\n");
}

/**
 * Splits text into chunks of specified size (for Slack message limits)
 */
function chunkText(text, size = 2900) {
	const chunks = [];
	for (let i = 0; i < text.length; i += size) {
		chunks.push(text.slice(i, i + size));
	}
	return chunks.length ? chunks : [""];
}

// ============================================================================
// Claude CLI Integration
// ============================================================================

/**
 * Spawns Claude CLI with the given prompt and streams updates via callback
 */
function runClaude(prompt, onUpdate) {
	const state = getProjectState();

	const args = [
		"-p",
		buildPrompt(prompt),
		"--output-format",
		"stream-json",
		"--dangerously-skip-permissions",
		"--verbose",
	];

	if (state.sessionId) {
		args.push("--resume", state.sessionId);
		console.log("[claude] resuming session", state.sessionId);
	} else {
		console.log("[claude] starting new session for", PROJECT_DIR);
	}

	return new Promise((resolve, reject) => {
		console.log("[claude] spawning with prompt:", prompt.slice(0, 80), "...");

		const proc = spawn("claude", args, {
			cwd: PROJECT_DIR,
			env: process.env,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let buffer = "";
		let stderr = "";

		proc.stdout.on("data", (data) => {
			buffer += data;
			const lines = buffer.split("\n");
			buffer = lines.pop();

			for (const line of lines) {
				if (!line.trim()) continue;

				try {
					const event = JSON.parse(line);

					// Handle assistant messages (tool usage and thinking)
					if (event.type === "assistant") {
						const blocks = event.message?.content ?? [];
						const parts = [];

						for (const block of blocks) {
							if (block.type === "tool_use") {
								const input = JSON.stringify(block.input ?? {});
								const truncated = input.length > 120 ? input.slice(0, 120) + "…" : input;
								parts.push(`\`${block.name}\` ${truncated}`);
							}
							if (block.type === "text" && block.text?.trim()) {
								const text = block.text.trim();
								const truncated = text.length > 300 ? text.slice(0, 300) + "…" : text;
								parts.push(`💭 ${truncated}`);
							}
						}

						if (parts.length) onUpdate(parts.join("\n"));
					}

					// Handle final result
					if (event.type === "result") {
						if (event.session_id) {
							state.sessionId = event.session_id;
							console.log("[claude] session saved:", event.session_id);
						}
						if (event.usage) {
							state.inputTokens += event.usage.input_tokens ?? 0;
							state.outputTokens += event.usage.output_tokens ?? 0;
						}
						if (event.is_error) {
							reject(new Error(event.result || "Claude returned an error"));
						} else {
							resolve(event.result || "_No output_");
						}
					}
				} catch (e) {
					// Non-JSON line — ignore
				}
			}
		});

		proc.stderr.on("data", (data) => {
			stderr += data;
			console.error("[claude stderr]", data);
		});

		proc.on("close", (code) => {
			console.log("[claude] exited with code", code);
			if (code !== 0) {
				reject(new Error(stderr.trim() || `claude exited with code ${code}`));
			}
		});

		proc.on("error", (err) => {
			reject(new Error(`Failed to spawn claude: ${err.message}`));
		});

		// Timeout after 5 minutes
		setTimeout(() => {
			proc.kill();
			reject(new Error("Claude request timed out after 5 minutes"));
		}, 300000);
	});
}

// ============================================================================
// Slack Command Handlers
// ============================================================================

// /cost — Display accumulated token usage and cost
app.command("/cost", async ({ ack, client, body }) => {
	await ack();
	await client.chat.postMessage({
		channel: body.channel_id,
		text: costSummary(getProjectState()),
	});
});

// /exit — Show cost summary, then clear everything including rules
app.command("/exit", async ({ ack, client, body }) => {
	await ack();
	const state = getProjectState();
	const hadSession = !!state.sessionId;
	const summary = hadSession ? costSummary(state) : "_No active session_";
	clearProjectState();

	await client.chat.postMessage({
		channel: body.channel_id,
		text: ["🔴 Session ended for `" + PROJECT_DIR + "`", summary].join("\n"),
	});
});

// /new — Clear everything including rules, start fresh
app.command("/new", async ({ ack, client, body }) => {
	await ack();
	clearProjectState();

	await client.chat.postMessage({
		channel: body.channel_id,
		text: "🆕 New session started for `" + PROJECT_DIR + "` — previous context and rules cleared",
	});
});

// /rule — Manage session rules (add, remove, list, clear)
app.command("/rule", async ({ ack, client, body }) => {
	await ack();
	const args = (body.text ?? "").trim().toLowerCase().split(/\s+/);
	const subcommand = args[0] || null;
	const key = args[1] || null;
	const channel = body.channel_id;
	const { rules } = getProjectState();

	// /rule or /rule list — show active rules
	if (!subcommand || subcommand === "list") {
		if (rules.size === 0) {
			await client.chat.postMessage({
				channel,
				text: "📋 No active session rules.",
			});
		} else {
			const lines = [...rules].map((r) => `• *${r}*: ${RULE_DEFINITIONS[r]}`);
			await client.chat.postMessage({
				channel,
				text: "📋 *Active rules:*\n" + lines.join("\n"),
			});
		}
		return;
	}

	// /rule add <key> — add a rule
	if (subcommand === "add") {
		if (!key || !RULE_DEFINITIONS[key]) {
			const available = Object.keys(RULE_DEFINITIONS).join(", ");
			await client.chat.postMessage({
				channel,
				text: "❓ Unknown rule `" + key + "`. Available: " + available,
			});
			return;
		}
		rules.add(key);
		await client.chat.postMessage({
			channel,
			text: "✅ Rule added: *" + key + "*\n_" + RULE_DEFINITIONS[key] + "_",
		});
		return;
	}

	// /rule remove <key> — remove a rule
	if (subcommand === "remove") {
		if (!key || !rules.has(key)) {
			await client.chat.postMessage({
				channel,
				text: "❓ Rule `" + key + "` is not currently active.",
			});
			return;
		}
		rules.delete(key);
		await client.chat.postMessage({
			channel,
			text: "🗑️ Rule removed: *" + key + "*",
		});
		return;
	}

	// /rule clear — clear all rules
	if (subcommand === "clear") {
		rules.clear();
		await client.chat.postMessage({
			channel,
			text: "🗑️ All rules cleared.",
		});
		return;
	}

	// Unknown subcommand
	await client.chat.postMessage({
		channel,
		text: "❓ Unknown subcommand `" + subcommand + "`. Usage: `/rule add|remove|list|clear [key]`",
	});
});

// ============================================================================
// Message Handler
// ============================================================================

app.message(async ({ message, client }) => {
	// Ignore bot messages
	if (message.bot_id) return;
	if (!message.text) return;

	// Ignore message changes (only handle new messages)
	if (message.subtype && message.subtype !== "message_changed") return;

	// Only respond to messages in the configured channel
	if (message.channel !== process.env.SLACK_CHANNEL_ID) return;

	console.log("[slack] received:", message.text);

	// Post a placeholder while processing
	let placeholder;
	try {
		placeholder = await client.chat.postMessage({
			channel: message.channel,
			text: "⏳ Running in `" + PROJECT_DIR + "`...",
		});
	} catch (err) {
		console.error("[bridge] Failed to post placeholder:", err.message);
		return;
	}

	// Callback to post updates (tool usage, thinking) as they happen
	const onUpdate = async (text) => {
		try {
			await client.chat.postMessage({
				channel: message.channel,
				thread_ts: placeholder.ts,
				text,
			});
		} catch (e) {
			console.error("[bridge] Failed to post update:", e.message);
		}
	};

	try {
		const response = await runClaude(message.text, onUpdate);
		const chunks = chunkText(response);

		// Update the placeholder with the first chunk
		await client.chat.update({
			channel: message.channel,
			ts: placeholder.ts,
			text: chunks[0] || "_No output_",
		});

		// Post any remaining chunks
		for (const chunk of chunks.slice(1)) {
			await client.chat.postMessage({
				channel: message.channel,
				text: chunk,
			});
		}
	} catch (err) {
		console.error("[bridge error]", err.message);

		// Truncate error message if too long
		let errorText = "❌ Error: " + err.message;
		if (errorText.length > 2900) {
			errorText = errorText.slice(0, 2897) + "...";
		}

		try {
			await client.chat.update({
				channel: message.channel,
				ts: placeholder.ts,
				text: errorText,
			});
		} catch {
			await client.chat.postMessage({
				channel: message.channel,
				text: errorText,
			});
		}
	}
});

// ============================================================================
// Error Handling & Graceful Shutdown
// ============================================================================

// Connection error handler
app.error(async (error) => {
	console.error("[bridge] Slack connection error:", error.message);
});

// Graceful shutdown on SIGINT/SIGTERM
async function shutdown(signal) {
	console.log("\n[bridge] Received", signal, ", shutting down...");

	try {
		await app.client.chat.postMessage({
			channel: process.env.SLACK_CHANNEL_ID,
			text: "🔴 Bridge shutting down (" + signal + ")\n" + costSummary(getProjectState()),
		});
	} catch (e) {
		console.error("[bridge] Could not post shutdown message:", e.message);
	}

	await app.stop();
	process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// ============================================================================
// Start the App
// ============================================================================

(async () => {
	await app.start();

	await app.client.chat.postMessage({
		channel: process.env.SLACK_CHANNEL_ID,
		text: "⚡ Bridge started — project: `" + PROJECT_DIR + "`",
	});

	console.log("✅ Bridge running — listening for messages in channel", process.env.SLACK_CHANNEL_ID);
})();
