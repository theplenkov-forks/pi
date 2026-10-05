/**
 * Convert a pi transcript into ACP prompt content blocks.
 *
 * The ACP session is stateful (like a Zed thread): it remembers everything
 * already prompted, so callers send only the transcript delta. Pi tool calls
 * are never forwarded — the ACP agent owns tool execution. Non-user history
 * (assistant text, foreign tool calls/results) is rendered as quoted text so
 * a mid-session model switch still carries context.
 */

import type { ContentBlock } from "@agentclientprotocol/sdk";
import type { Message } from "../types.ts";
import { contentText } from "../utils/text.ts";

function assistantText(message: Extract<Message, { role: "assistant" }>): string {
	return message.content
		.map((block) => {
			if (block.type === "text") return block.text;
			if (block.type === "toolCall") return `Tool call \`${block.name}\`: ${JSON.stringify(block.arguments)}`;
			return "";
		})
		.filter((part) => part.length > 0)
		.join("\n\n");
}

function toolResultText(message: Extract<Message, { role: "toolResult" }>): string {
	const text = contentText(message.content);
	const label = message.isError ? "Tool error" : "Tool result";
	return `${label} \`${message.toolName}\`: ${text}`;
}

/**
 * Build ACP prompt blocks for transcript messages not yet sent to the session.
 * Pass the replayed system prompt only for the first prompt of a session.
 */
export function transcriptToAcpPrompt(
	messages: readonly Message[],
	options?: { systemPrompt?: string },
): ContentBlock[] {
	const blocks: ContentBlock[] = [];
	const systemPrompt = options?.systemPrompt?.trim();
	if (systemPrompt) blocks.push({ type: "text", text: systemPrompt });

	for (const message of messages) {
		if (message.role === "system") continue;
		if (message.role === "user") {
			if (typeof message.content === "string") {
				if (message.content.trim().length > 0) blocks.push({ type: "text", text: message.content });
				continue;
			}
			let text = "";
			const images: ContentBlock[] = [];
			for (const block of message.content) {
				if (block.type === "text") text += block.text;
				else images.push({ type: "image", data: block.data, mimeType: block.mimeType });
			}
			if (text.trim().length > 0) blocks.push({ type: "text", text });
			blocks.push(...images);
			continue;
		}
		if (message.role === "assistant") {
			const text = assistantText(message);
			if (text.length > 0) blocks.push({ type: "text", text: `Assistant: ${text}` });
			continue;
		}
		const text = toolResultText(message);
		if (text.length > 0) blocks.push({ type: "text", text });
	}
	return blocks;
}
