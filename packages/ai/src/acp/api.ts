/**
 * `ProviderStreams` implementation for ACP agents.
 *
 * The ACP agent owns the agentic loop (tools, plans, permissions), so pi
 * acts as a thin client like Zed: agent text becomes pi text blocks, agent
 * thoughts/tool activity become thinking blocks, and turns always terminate
 * with `stop`/`length` (never `toolUse`).
 */

import type { SessionNotification, SessionUpdate, ToolCallContent } from "@agentclientprotocol/sdk";
import { calculateCost } from "../models.ts";
import type {
	AssistantMessage,
	Message,
	Model,
	ProviderStreams,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
	TranscriptContext,
	Usage,
} from "../types.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { getCurrentSystemPrompt } from "../utils/transcript.ts";
import { type AcpPromptResult, type AcpRunOptions, runAcpPrompt } from "./pool.ts";
import { type AcpTransportConfig, resolveAcpTransport } from "./types.ts";

export type AcpRunner = (
	transport: AcpTransportConfig,
	messages: readonly Message[],
	options?: AcpRunOptions,
) => Promise<AcpPromptResult>;

function zeroUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function toolCallContentText(content: ToolCallContent): string | undefined {
	if (content.type === "content") {
		const block = content.content;
		if (block.type === "text") return block.text;
		if (block.type === "resource_link") return `Resource: ${block.uri}`;
		return `[${block.type} content]`;
	}
	if (content.type === "diff") return `Changed ${content.path}`;
	return `[terminal ${content.terminalId}]`;
}

class AcpEventConverter {
	private readonly eventStream: AssistantMessageEventStream;
	private readonly partial: AssistantMessage;
	private textIndex = -1;
	private thinkingIndex = -1;
	private text = "";
	private thinking = "";
	/** Set when the other block kind writes, so the next write starts a new block. */
	private afterText = false;
	private afterThinking = false;

	constructor(eventStream: AssistantMessageEventStream, model: Model<"acp">) {
		this.eventStream = eventStream;
		this.partial = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: zeroUsage(),
			stopReason: "pending",
			timestamp: Date.now(),
		};
	}

	start(): void {
		this.eventStream.push({ type: "start", partial: this.partial });
	}

	// Each kind keeps one open block, but a write that follows the other kind
	// starts a new block so ACP's own ordering survives into the message.
	appendText(delta: string): void {
		if (this.textIndex < 0 || this.afterThinking) this.startText();
		this.afterText = true;
		this.afterThinking = false;
		this.text += delta;
		(this.partial.content[this.textIndex] as { text: string }).text = this.text;
		this.eventStream.push({ type: "text_delta", contentIndex: this.textIndex, delta, partial: this.partial });
	}

	appendThinking(delta: string): void {
		if (this.thinkingIndex < 0 || this.afterText) this.startThinking();
		// Separator depends on the block opened above, so compute after starting it.
		const line = this.thinking.length > 0 && !this.thinking.endsWith("\n") ? `\n${delta}` : delta;
		this.afterThinking = true;
		this.afterText = false;
		this.thinking += line;
		(this.partial.content[this.thinkingIndex] as { thinking: string }).thinking = this.thinking;
		this.eventStream.push({
			type: "thinking_delta",
			contentIndex: this.thinkingIndex,
			delta: line,
			partial: this.partial,
		});
	}

	private startText(): void {
		this.textIndex = this.partial.content.length;
		this.text = "";
		this.partial.content.push({ type: "text", text: "" });
		this.eventStream.push({ type: "text_start", contentIndex: this.textIndex, partial: this.partial });
	}

	private startThinking(): void {
		this.thinkingIndex = this.partial.content.length;
		this.thinking = "";
		this.partial.content.push({ type: "thinking", thinking: "" });
		this.eventStream.push({ type: "thinking_start", contentIndex: this.thinkingIndex, partial: this.partial });
	}

	handleUpdate(update: SessionUpdate): void {
		switch (update.sessionUpdate) {
			case "agent_message_chunk":
				if (update.content.type === "text") this.appendText(update.content.text);
				else this.appendThinking(`[${update.content.type} content]`);
				break;
			case "agent_thought_chunk":
				if (update.content.type === "text") this.appendThinking(update.content.text);
				else this.appendThinking(`[${update.content.type} content]`);
				break;
			case "tool_call":
				this.appendThinking(
					`Tool: ${update.title}${update.name ? ` (${update.name})` : ""} [${update.status ?? "pending"}]`,
				);
				break;
			case "tool_call_update": {
				if (update.status) this.appendThinking(`Tool ${update.toolCallId} -> ${update.status}`);
				for (const content of update.content ?? []) {
					const text = toolCallContentText(content);
					if (text) this.appendThinking(text);
				}
				for (const location of update.locations ?? []) this.appendThinking(`File: ${location.path}`);
				break;
			}
			case "plan":
				for (const entry of update.entries) this.appendThinking(`- [${entry.status}] ${entry.content}`);
				break;
			case "notice":
				this.appendThinking(
					`Notice [${update.severity}] ${update.title}${update.description ? `: ${update.description}` : ""}`,
				);
				break;
			case "user_message_chunk":
			case "available_commands_update":
			case "current_mode_update":
			case "config_option_update":
			case "session_info_update":
			case "usage_update":
			case "plan_update":
			case "plan_removed":
			case "compaction_update":
			case "compaction_summary_chunk":
			case "subagent_update":
			case "session_message":
			case "session_message_chunk":
				break;
		}
	}

	finish(model: Model<"acp">, result: AcpPromptResult, aborted: boolean): void {
		const usage: Usage = {
			input: result.turnUsage.input,
			output: result.turnUsage.output,
			cacheRead: result.turnUsage.cacheRead,
			cacheWrite: result.turnUsage.cacheWrite,
			totalTokens:
				result.turnUsage.input + result.turnUsage.output + result.turnUsage.cacheRead + result.turnUsage.cacheWrite,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		calculateCost(model, usage);
		if (result.turnUsage.costTotal !== undefined) usage.cost.total = result.turnUsage.costTotal;
		this.partial.usage = usage;

		this.partial.content.forEach((block, contentIndex) => {
			if (block.type === "text") {
				this.eventStream.push({ type: "text_end", contentIndex, content: block.text, partial: this.partial });
			} else if (block.type === "thinking") {
				this.eventStream.push({
					type: "thinking_end",
					contentIndex,
					content: block.thinking,
					partial: this.partial,
				});
			}
		});

		const stopReason = result.stopReason;
		if (stopReason === "cancelled") {
			this.partial.stopReason = "aborted";
			this.partial.errorMessage = aborted ? "Request aborted" : "The agent cancelled the turn";
			this.eventStream.push({ type: "error", reason: "aborted", error: this.partial });
		} else if (stopReason === "refusal") {
			this.partial.stopReason = "error";
			this.partial.errorMessage = "The agent refused to continue";
			this.eventStream.push({ type: "error", reason: "error", error: this.partial });
		} else if (stopReason === "max_tokens" || stopReason === "max_turn_requests") {
			this.partial.stopReason = "length";
			this.eventStream.push({ type: "done", reason: "length", message: this.partial });
		} else if (stopReason === "end_turn") {
			this.partial.stopReason = "stop";
			this.eventStream.push({ type: "done", reason: "stop", message: this.partial });
		} else {
			// An unknown or newly added ACP stop reason must not read as a clean
			// completion: report it instead of guessing.
			this.partial.stopReason = "error";
			this.partial.errorMessage = `The agent stopped with an unrecognized reason: ${stopReason}`;
			this.eventStream.push({ type: "error", reason: "error", error: this.partial });
		}
	}

	fail(error: unknown, aborted: boolean): void {
		this.partial.stopReason = aborted ? "aborted" : "error";
		this.partial.errorMessage = error instanceof Error ? error.message : String(error);
		this.eventStream.push({ type: "error", reason: this.partial.stopReason, error: this.partial });
	}
}

/** Build ACP streams. The transport comes from each model; no defaults are assumed. */
export function createAcpStreams(runner: AcpRunner = runAcpPrompt): ProviderStreams {
	const run = (
		model: Model<"acp">,
		context: TranscriptContext,
		options?: StreamOptions | SimpleStreamOptions,
	): AssistantMessageEventStream => {
		const eventStream = new AssistantMessageEventStream();
		const converter = new AcpEventConverter(eventStream, model);
		void (async () => {
			try {
				const transport = resolveAcpTransport(undefined, model.acp);
				if (!transport) {
					throw new Error(
						`Model ${model.provider}/${model.id} has no ACP command configured. Set "command" for the provider or model in models.json.`,
					);
				}
				let payload: unknown = { transport, messageCount: context.messages.length };
				const nextPayload = await options?.onPayload?.(payload, model);
				if (nextPayload !== undefined) payload = nextPayload;
				const blocks = Array.isArray(payload)
					? (payload as AcpRunOptions["blocks"])
					: (payload as { blocks?: AcpRunOptions["blocks"] })?.blocks;

				converter.start();
				let responded = false;
				const result = await runner(transport, context.messages, {
					sessionKey: options?.sessionId,
					signal: options?.signal,
					env: options?.env,
					systemPrompt: getCurrentSystemPrompt(context.messages),
					supportsImages: model.input.includes("image"),
					...(blocks ? { blocks } : {}),
					onUpdate: async (notification: SessionNotification) => {
						if (!responded) {
							responded = true;
							await options?.onResponse?.({ status: 200, headers: {} }, model);
						}
						await options?.onProviderStreamEvent?.(notification, model);
						converter.handleUpdate(notification.update);
					},
				});
				if (!responded) await options?.onResponse?.({ status: 200, headers: {} }, model);
				converter.finish(model, result, options?.signal?.aborted ?? false);
			} catch (error) {
				converter.fail(error, options?.signal?.aborted ?? false);
			}
		})();
		return eventStream;
	};
	return {
		stream: (model, context, options) => run(model as Model<"acp">, context, options),
		streamSimple: (model, context, options) => run(model as Model<"acp">, context, options),
	};
}

const defaultStreams = createAcpStreams();

export const stream: StreamFunction<"acp"> = (model, context, options) =>
	defaultStreams.stream(model, context, options);

export const streamSimple: StreamFunction<"acp", SimpleStreamOptions> = (model, context, options) =>
	defaultStreams.streamSimple(model, context, options);
