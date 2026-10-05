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
		expect(message.content).toHaveLength(1);
		expect(message.content[0]?.type).toBe("thinking");
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

	it("maps cancellation to aborted", async () => {
		const controller = new AbortController();
		const streams = createAcpStreams(
			runnerFor([], { stopReason: "cancelled", turnUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
		);
		controller.abort();
		const message = await streams
			.streamSimple(createModel(), normalizeContext({ messages: [{ role: "user", content: "Hi", timestamp: 1 }] }), {
				signal: controller.signal,
			})
			.result();
		expect(message.stopReason).toBe("aborted");
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
		const streams = createAcpStreams(async (transport, messages, options) => {
			expect(transport.command).toBe("devin");
			expect(messages).toHaveLength(1);
			receivedBlocks = options?.blocks;
			await options?.onUpdate?.(textChunk("Hi"));
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
		expect(seen).toHaveLength(1);
		expect(responseStatus).toBe(200);
	});
});
