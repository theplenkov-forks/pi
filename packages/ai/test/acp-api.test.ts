import type { SessionNotification } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";
import { type AcpRunner, createAcpStreams } from "../src/acp/api.ts";
import type { AcpPromptResult } from "../src/acp/pool.ts";
import type { Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

function createModel(): Model<"acp"> {
	return {
		id: "devin",
		name: "Devin",
		api: "acp",
		provider: "devin",
		baseUrl: "acp://devin",
		input: ["text"],
		cost: { input: 3, output: 12, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16384,
		reasoning: false,
		acp: { command: "devin", args: ["acp"] },
	};
}

function runnerFor(updates: SessionNotification[], result: AcpPromptResult): AcpRunner {
	return async (_transport, _messages, options) => {
		for (const notification of updates) {
			await options?.onUpdate?.(notification);
		}
		return result;
	};
}

function textChunk(text: string): SessionNotification {
	return { sessionId: "sess_1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } };
}

function thoughtChunk(text: string): SessionNotification {
	return { sessionId: "sess_1", update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text } } };
}

describe("createAcpStreams", () => {
	it("streams agent text and thinking and terminates with stop", async () => {
		const streams = createAcpStreams(
			runnerFor([textChunk("Hel"), textChunk("lo"), thoughtChunk("plan")], {
				stopReason: "end_turn",
				turnUsage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
			}),
		);
		const model = createModel();
		const events: string[] = [];
		const eventStream = streams.streamSimple(
			model,
			normalizeContext({ messages: [{ role: "user", content: "Hi", timestamp: 1 }] }),
			{ sessionId: "pi-session" },
		);
		for await (const event of eventStream) events.push(event.type);
		const message = await eventStream.result();

		expect(events[0]).toBe("start");
		expect(events).toContain("text_start");
		expect(events).toContain("text_delta");
		expect(events).toContain("thinking_start");
		expect(events).toContain("done");
		expect(message.stopReason).toBe("stop");
		expect(message.content).toEqual([
			{ type: "text", text: "Hello" },
			{ type: "thinking", thinking: "plan" },
		]);
		expect(message.usage.input).toBe(100);
		expect(message.usage.output).toBe(50);
		// Cost follows the model's catalog rates: 100 * 3 + 50 * 12 per million.
		expect(message.usage.cost.total).toBeCloseTo((100 * 3 + 50 * 12) / 1000000, 10);
	});

	it("keeps text and thinking blocks in the agent's order", async () => {
		const streams = createAcpStreams(
			runnerFor([textChunk("a"), thoughtChunk("plan"), textChunk("b"), thoughtChunk("more")], {
				stopReason: "end_turn",
				turnUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			}),
		);
		const message = await streams
			.streamSimple(
				createModel(),
				normalizeContext({ messages: [{ role: "user", content: "Hi", timestamp: 1 }] }),
				{},
			)
			.result();
		expect(message.content).toEqual([
			{ type: "text", text: "a" },
			{ type: "thinking", thinking: "plan" },
			{ type: "text", text: "b" },
			{ type: "thinking", thinking: "more" },
		]);
	});

	it("reports an agent-initiated cancellation as an error, not an aborted request", async () => {
		const streams = createAcpStreams(
			runnerFor([], { stopReason: "cancelled", turnUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
		);
		// No aborted signal: the agent stopped on its own.
		const message = await streams
			.streamSimple(
				createModel(),
				normalizeContext({ messages: [{ role: "user", content: "Hi", timestamp: 1 }] }),
				{},
			)
			.result();
		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toBe("The agent cancelled the turn");
	});

	it("concatenates agent thought chunks verbatim", async () => {
		const streams = createAcpStreams(
			runnerFor([thoughtChunk("first half "), thoughtChunk("second half")], {
				stopReason: "end_turn",
				turnUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			}),
		);
		const message = await streams
			.streamSimple(
				createModel(),
				normalizeContext({ messages: [{ role: "user", content: "Hi", timestamp: 1 }] }),
				{},
			)
			.result();
		expect(message.content).toEqual([{ type: "thinking", thinking: "first half second half" }]);
	});

	it("reports an unrecognized agent stop reason instead of a clean finish", async () => {
		const streams = createAcpStreams(
			runnerFor([], {
				stopReason: "brand_new_reason" as never,
				turnUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			}),
		);
		const message = await streams
			.streamSimple(
				createModel(),
				normalizeContext({ messages: [{ role: "user", content: "Hi", timestamp: 1 }] }),
				{},
			)
			.result();
		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain("brand_new_reason");
	});

	it("renders tool calls as thinking and overrides cost with the agent total", async () => {
		const streams = createAcpStreams(
			runnerFor(
				[
					{
						sessionId: "sess_1",
						update: {
							sessionUpdate: "tool_call",
							toolCallId: "call_1",
							title: "Reading file",
							status: "in_progress",
						},
					},
					{
						sessionId: "sess_1",
						update: {
							sessionUpdate: "tool_call_update",
							toolCallId: "call_1",
							status: "completed",
							content: [{ type: "content", content: { type: "text", text: "done" } }],
						},
					},
				],
				{
					stopReason: "end_turn",
					turnUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costTotal: 0.045 },
				},
			),
		);
		const message = await streams
			.streamSimple(
				createModel(),
				normalizeContext({ messages: [{ role: "user", content: "Hi", timestamp: 1 }] }),
				{},
			)
			.result();

		expect(message.stopReason).toBe("stop");
		expect(message.content).toEqual([
			{
				type: "thinking",
				thinking: "Tool: Reading file [in_progress]\nTool call_1 -> completed\ndone",
			},
		]);
		expect(message.usage.cost.total).toBe(0.045);
	});

	it("maps refusal to error and max_tokens to length", async () => {
		const refusal = createAcpStreams(
			runnerFor([], { stopReason: "refusal", turnUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
		);
		const refused = await refusal
			.streamSimple(
				createModel(),
				normalizeContext({ messages: [{ role: "user", content: "Hi", timestamp: 1 }] }),
				{},
			)
			.result();
		expect(refused.stopReason).toBe("error");
		expect(refused.errorMessage).toContain("refused");

		const truncated = createAcpStreams(
			runnerFor([], { stopReason: "max_tokens", turnUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
		);
		const message = await truncated
			.streamSimple(
				createModel(),
				normalizeContext({ messages: [{ role: "user", content: "Hi", timestamp: 1 }] }),
				{},
			)
			.result();
		expect(message.stopReason).toBe("length");
	});

	it("maps an aborted request to aborted and forwards the signal to the runner", async () => {
		const controller = new AbortController();
		let sawSignal: AbortSignal | undefined;
		const streams = createAcpStreams(async (_transport, _messages, options) => {
			sawSignal = options?.signal;
			// An aborted request must not report a clean finish.
			expect(controller.signal.aborted).toBe(true);
			return { stopReason: "cancelled", turnUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
		});
		const pending = streams.streamSimple(
			createModel(),
			normalizeContext({ messages: [{ role: "user", content: "Hi", timestamp: 1 }] }),
			{ signal: controller.signal },
		);
		controller.abort();
		const message = await pending.result();
		expect(sawSignal).toBe(controller.signal);
		expect(message.stopReason).toBe("aborted");
		expect(message.errorMessage).toBe("Request aborted");
	});

	it("errors when the model has no ACP command", async () => {
		const streams = createAcpStreams(
			runnerFor([], { stopReason: "end_turn", turnUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
		);
		const model = { ...createModel(), acp: undefined };
		const message = await streams
			.streamSimple(model, normalizeContext({ messages: [{ role: "user", content: "Hi", timestamp: 1 }] }), {})
			.result();
		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain("no ACP command");
	});

	it("forwards provider stream events and honors onPayload block replacement", async () => {
		const seen: unknown[] = [];
		let responseStatus = 0;
		let receivedBlocks: unknown;
		const emitted = textChunk("Hi");
		const streams = createAcpStreams(async (transport, messages, options) => {
			expect(transport.command).toBe("devin");
			expect(messages).toHaveLength(1);
			receivedBlocks = options?.blocks;
			await options?.onUpdate?.(emitted);
			return { stopReason: "end_turn", turnUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
		});
		const message = await streams
			.streamSimple(createModel(), normalizeContext({ messages: [{ role: "user", content: "Hi", timestamp: 1 }] }), {
				onProviderStreamEvent: async (event) => {
					seen.push(event);
				},
				onResponse: (response) => {
					responseStatus = response.status;
				},
				onPayload: () => [{ type: "text", text: "replaced" }],
			})
			.result();
		expect(message.stopReason).toBe("stop");
		expect(receivedBlocks).toEqual([{ type: "text", text: "replaced" }]);
		// The raw notification, not a converted or partial event.
		expect(seen).toEqual([emitted]);
		expect(responseStatus).toBe(200);
	});

	it("tells the runner whether the model accepts images", async () => {
		let supportsImages: boolean | undefined;
		const streams = createAcpStreams(async (_transport, _messages, options) => {
			supportsImages = options?.supportsImages;
			return { stopReason: "end_turn", turnUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
		});
		await streams
			.streamSimple(
				{ ...createModel(), input: ["text", "image"] },
				normalizeContext({ messages: [{ role: "user", content: "Hi", timestamp: 1 }] }),
				{},
			)
			.result();
		expect(supportsImages).toBe(true);
		await streams
			.streamSimple(
				createModel(),
				normalizeContext({ messages: [{ role: "user", content: "Hi", timestamp: 1 }] }),
				{},
			)
			.result();
		expect(supportsImages).toBe(false);
	});
});
