/**
 * Minimal ACP agent used by pool tests: speaks the real protocol over stdio
 * (NDJSON JSON-RPC) so the pool runs against real pipes, not a fake runner.
 *
 * Behavior knobs (env):
 * - ACP_FAKE_TURN_USAGE=input,output  cumulative usage reported per turn
 * - ACP_FAKE_STOP_REASON=end_turn|max_tokens|refusal|cancelled
 * - ACP_FAKE_FAIL_PROMPT=1            reject session/prompt with an error
 * - ACP_FAKE_SLOW_INIT_MS=50          delay initialize so spawn races are observable
 * - ACP_FAKE_MODEL_OPTIONS=3          advertise N model config options
 * - ACP_FAKE_NO_MODEL_OPTIONS=1       omit config options entirely
 * - ACP_FAKE_SPAWN_LOG=/path          append one line per spawned agent process
 */

import { appendFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

const spawnLog = process.env.ACP_FAKE_SPAWN_LOG;
if (spawnLog) appendFileSync(spawnLog, `${process.pid}\n`);

const usage = process.env.ACP_FAKE_TURN_USAGE?.split(",").map(Number);
const stopReason = (process.env.ACP_FAKE_STOP_REASON ?? "end_turn") as acp.StopReason;
/** Cumulative turn count per ACP session; the pool diffs usage per session. */
const turnsBySession = new Map<string, number>();

const app = acp
	.agent({ name: "fake-acp" })
	.onRequest(acp.methods.agent.initialize, async () => {
		const delay = Number(process.env.ACP_FAKE_SLOW_INIT_MS ?? 0);
		if (delay > 0) await new Promise((r) => setTimeout(r, delay));
		return {
			protocolVersion: acp.PROTOCOL_VERSION,
			agentCapabilities: { loadSession: false, promptCapabilities: { image: true } },
			authMethods: [],
		};
	})
	.onRequest(acp.methods.agent.session.new, () => {
		const modelOptions = process.env.ACP_FAKE_NO_MODEL_OPTIONS
			? undefined
			: Array.from({ length: Number(process.env.ACP_FAKE_MODEL_OPTIONS ?? 0) }, (_, index) => ({
					value: `fake-${index}`,
					name: `Fake ${index}`,
				}));
		return {
			sessionId: `sess_${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
			modes: { currentModeId: "chat", availableModes: [{ id: "chat", name: "Chat" }] },
			...(modelOptions?.length
				? {
						configOptions: [
							{
								id: "model",
								name: "Model",
								category: "model",
								type: "select" as const,
								currentValue: modelOptions[0]?.value ?? "",
								options: modelOptions,
							},
						],
					}
				: {}),
		};
	})
	.onRequest(acp.methods.agent.session.prompt, async (ctx) => {
		if (process.env.ACP_FAKE_FAIL_PROMPT) throw new Error("fake prompt failure");
		// Cumulative usage is per session: the pool diffs it per ACP session, and
		// several sessions share one pooled process.
		const turnCount = (turnsBySession.get(ctx.params.sessionId) ?? 0) + 1;
		turnsBySession.set(ctx.params.sessionId, turnCount);
		const text = [
			ctx.params.prompt
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join(" "),
			// Echo one environment variable so tests can prove the spawn env.
			process.env.ACP_FAKE_ECHO_ENV ? `env:${process.env[process.env.ACP_FAKE_ECHO_ENV] ?? ""}` : "",
		]
			.filter(Boolean)
			.join(" ");
		await ctx.client.notify(acp.methods.client.session.update, {
			sessionId: ctx.params.sessionId,
			update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `echo:${text}` } },
		});
		const inputTokens = usage?.[0] ? usage[0] * turnCount : 0;
		const outputTokens = usage?.[1] ? usage[1] * turnCount : 0;
		return {
			stopReason,
			usage: { totalTokens: inputTokens + outputTokens, inputTokens, outputTokens },
		};
	})
	.onNotification(acp.methods.agent.session.cancel, () => {})
	.onRequest(acp.methods.agent.session.close, () => ({}));

const input = Writable.toWeb(process.stdout);
const output = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
app.connect(acp.ndJsonStream(input, output));
