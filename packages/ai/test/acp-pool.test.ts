import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { closeAcpPool, fetchAcpSessionInfo, runAcpPrompt } from "../src/acp/pool.ts";
import type { AcpTransportConfig } from "../src/acp/types.ts";
import type { Message } from "../src/types.ts";

const agentEntry = fileURLToPath(new URL("./acp-fake-agent.ts", import.meta.url));

function transport(env: Record<string, string> = {}): AcpTransportConfig {
	return { command: process.execPath, args: [agentEntry], env };
}

const timestamp = 1700000000000;

function user(text: string): Message {
	return { role: "user", content: text, timestamp };
}

/** Same shape, different identity: models that rebuild messages must not diverge. */
function rebuilt(messages: readonly Message[]): Message[] {
	return messages.map((message) => ({ ...message }));
}

/** Minimal assistant message so transcript deltas look like real pi history. */
function assistant(text: string): Message {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "acp",
		provider: "fake",
		model: "fake",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp,
	};
}

afterEach(async () => {
	await closeAcpPool();
});

describe("runAcpPrompt over a real ACP subprocess", () => {
	it("streams agent text and reports turn usage", async () => {
		const texts: string[] = [];
		const result = await runAcpPrompt(transport({ ACP_FAKE_TURN_USAGE: "100,10" }), [user("hello")], {
			sessionKey: "s1",
			onUpdate: (notification) => {
				if (notification.update.sessionUpdate === "agent_message_chunk") {
					texts.push(notification.update.content.type === "text" ? notification.update.content.text : "");
				}
			},
		});
		expect(result.stopReason).toBe("end_turn");
		expect(texts).toEqual(["echo:hello"]);
		expect(result.turnUsage).toEqual({ input: 100, output: 10, cacheRead: 0, cacheWrite: 0 });
	});

	it("sends only the transcript delta on later turns", async () => {
		const first = await runAcpPrompt(transport(), [user("one")], { sessionKey: "s2" });
		expect(first.stopReason).toBe("end_turn");
		const texts: string[] = [];
		// The ACP session already holds "one" and its own reply; only "two" is new.
		await runAcpPrompt(transport(), [user("one"), assistant("one"), user("two")], {
			sessionKey: "s2",
			onUpdate: (notification) => {
				if (notification.update.sessionUpdate === "agent_message_chunk") {
					texts.push(notification.update.content.type === "text" ? notification.update.content.text : "");
				}
			},
		});
		expect(texts).toEqual(["echo:two"]);
	});

	it("replays foreign history after a mid-session switch", async () => {
		await runAcpPrompt(transport(), [user("one")], { sessionKey: "s3" });
		const texts: string[] = [];
		await runAcpPrompt(
			transport(),
			[
				user("one"),
				assistant("one"),
				{
					role: "toolResult",
					toolCallId: "c1",
					toolName: "read",
					content: [{ type: "text", text: "data" }],
					isError: false,
					timestamp,
				},
				user("two"),
			],
			{
				sessionKey: "s3",
				onUpdate: (notification) => {
					if (notification.update.sessionUpdate === "agent_message_chunk") {
						texts.push(notification.update.content.type === "text" ? notification.update.content.text : "");
					}
				},
			},
		);
		expect(texts).toEqual(["echo:Tool result `read`: data two"]);
	});

	it("keeps the session when the transcript is rebuilt with new message objects", async () => {
		const history = [user("one"), assistant("one")];
		await runAcpPrompt(transport(), history, { sessionKey: "s9" });
		const texts: string[] = [];
		// Same history, rebuilt objects (a custom convertToLlm may do this): the
		// fingerprint matches, so only the new user message is sent.
		await runAcpPrompt(transport(), [...rebuilt(history), user("two")], {
			sessionKey: "s9",
			onUpdate: (notification) => {
				if (notification.update.sessionUpdate === "agent_message_chunk") {
					texts.push(notification.update.content.type === "text" ? notification.update.content.text : "");
				}
			},
		});
		expect(texts).toEqual(["echo:two"]);
	});

	it("starts a fresh ACP session when the transcript rewinds", async () => {
		await runAcpPrompt(transport(), [user("one"), assistant("one")], { sessionKey: "s4" });
		const texts: string[] = [];
		await runAcpPrompt(transport(), [user("fresh")], {
			sessionKey: "s4",
			onUpdate: (notification) => {
				if (notification.update.sessionUpdate === "agent_message_chunk") {
					texts.push(notification.update.content.type === "text" ? notification.update.content.text : "");
				}
			},
		});
		expect(texts).toEqual(["echo:fresh"]);
	});

	it("replays the full transcript into a new session when the system prompt changes", async () => {
		await runAcpPrompt(transport(), [user("one")], { sessionKey: "s5", systemPrompt: "first" });
		const texts: string[] = [];
		await runAcpPrompt(transport(), [user("one"), assistant("one"), user("two")], {
			sessionKey: "s5",
			systemPrompt: "second",
			onUpdate: (notification) => {
				if (notification.update.sessionUpdate === "agent_message_chunk") {
					texts.push(notification.update.content.type === "text" ? notification.update.content.text : "");
				}
			},
		});
		// A fresh ACP session has no memory, so the new prompt and all history replay.
		expect(texts).toEqual(["echo:second one Assistant: one two"]);
	});

	it("starts a fresh ACP session when earlier history is replaced while the transcript grows", async () => {
		await runAcpPrompt(transport(), [user("one"), assistant("one")], { sessionKey: "s8" });
		const texts: string[] = [];
		// The first user message was edited and the transcript then grew past the
		// sent boundary: the session's prefix no longer matches what pi holds.
		await runAcpPrompt(
			transport(),
			[user("edited"), assistant("one"), { role: "user", content: "two", timestamp: timestamp + 1 }],
			{
				sessionKey: "s8",
				onUpdate: (notification) => {
					if (notification.update.sessionUpdate === "agent_message_chunk") {
						texts.push(notification.update.content.type === "text" ? notification.update.content.text : "");
					}
				},
			},
		);
		expect(texts).toEqual(["echo:edited Assistant: one two"]);
	});

	it("shares one process across concurrent first calls", async () => {
		const log = join(tmpdir(), `acp-spawn-${process.pid}-${Date.now()}.log`);
		const acpTransport = transport({ ACP_FAKE_SLOW_INIT_MS: "80", ACP_FAKE_SPAWN_LOG: log });
		const [a, b, c] = await Promise.all([
			runAcpPrompt(acpTransport, [user("a")], { sessionKey: "c1" }),
			runAcpPrompt(acpTransport, [user("b")], { sessionKey: "c2" }),
			runAcpPrompt(acpTransport, [user("c")], { sessionKey: "c3" }),
		]);
		expect([a.stopReason, b.stopReason, c.stopReason]).toEqual(["end_turn", "end_turn", "end_turn"]);
		// Without spawn deduplication the slow initialize lets all three race.
		expect(readFileSync(log, "utf-8").trim().split("\n")).toHaveLength(1);
		rmSync(log, { force: true });
	});

	it("replays the transcript after a rejected prompt", async () => {
		await expect(
			runAcpPrompt(transport({ ACP_FAKE_FAIL_PROMPT: "1" }), [user("one")], { sessionKey: "s6" }),
		).rejects.toThrow(/prompt failed/);
		const texts: string[] = [];
		// The rejected blocks were never accepted, so the next turn resends them
		// rather than skipping messages the agent never received.
		await runAcpPrompt(transport(), [user("one"), assistant("one"), user("two")], {
			sessionKey: "s6",
			onUpdate: (notification) => {
				if (notification.update.sessionUpdate === "agent_message_chunk") {
					texts.push(notification.update.content.type === "text" ? notification.update.content.text : "");
				}
			},
		});
		expect(texts).toEqual(["echo:one Assistant: one two"]);
	});

	it("reports cancelled turns and drops the stale session", async () => {
		// Warm the pooled process and session first so the abort lands on the turn.
		await runAcpPrompt(transport(), [user("one")], { sessionKey: "s7" });
		const controller = new AbortController();
		const pending = runAcpPrompt(transport(), [user("one"), assistant("one"), user("two")], {
			sessionKey: "s7",
			signal: controller.signal,
		});
		controller.abort();
		expect((await pending).stopReason).toBe("cancelled");
	});

	it("maps agent stop reasons verbatim", async () => {
		const result = await runAcpPrompt(transport({ ACP_FAKE_STOP_REASON: "max_tokens" }), [user("hi")], {});
		expect(result.stopReason).toBe("max_tokens");
	});
});

describe("fetchAcpSessionInfo", () => {
	it("reports agent-advertised model options and modes", async () => {
		const info = await fetchAcpSessionInfo(transport({ ACP_FAKE_MODEL_OPTIONS: "3" }));
		expect(info.modes?.currentModeId).toBe("chat");
		const models = info.configOptions?.find((option) => option.category === "model");
		expect(models && "options" in models ? models.options.length : 0).toBe(3);
	});

	it("tolerates agents without config options", async () => {
		const info = await fetchAcpSessionInfo(transport({ ACP_FAKE_NO_MODEL_OPTIONS: "1" }));
		expect(info.configOptions ?? []).toHaveLength(0);
	});
});
