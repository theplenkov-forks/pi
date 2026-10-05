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
			if (block.type === "thinking") return `Thinking: ${block.thinking}`;
			if (block.type === "toolCall") return `Tool call \`${block.name}\`: ${JSON.stringify(block.arguments)}`;
			return "";
		})
		.filter((part) => part.length > 0)
		.join("\n\n");
}

/**
 * Tool-result blocks. Text becomes the labelled quoted form; images are kept as
 * image blocks so a vision-capable ACP agent can still inspect them.
 */
function toolResultBlocks(message: Extract<Message, { role: "toolResult" }>, supportsImages: boolean): ContentBlock[] {
	const label = message.isError ? "Tool error" : "Tool result";
	const blocks: ContentBlock[] = [];
	const text = contentText(message.content);
	if (text.length > 0) blocks.push({ type: "text", text: `${label} \`${message.toolName}\`: ${text}` });
	if (!supportsImages || typeof message.content === "string") return blocks;
	for (const block of message.content) {
		if (block.type === "image") blocks.push({ type: "image", data: block.data, mimeType: block.mimeType });
	}
	return blocks;
}

/**
 * Build ACP prompt blocks for transcript messages not yet sent to the session.
 * Pass the replayed system prompt only for the first prompt of a session.
 */
export function transcriptToAcpPrompt(
	messages: readonly Message[],
	options?: { systemPrompt?: string; supportsImages?: boolean },
): ContentBlock[] {
	const blocks: ContentBlock[] = [];
	const systemPrompt = options?.systemPrompt;
	// Send the prompt verbatim; only skip it when there is nothing but whitespace.
	if (systemPrompt && systemPrompt.trim().length > 0) blocks.push({ type: "text", text: systemPrompt });
	// A text-only ACP model rejects image blocks, so images are omitted for it.
	const supportsImages = options?.supportsImages ?? true;

	for (const message of messages) {
		if (message.role === "system") continue;
		if (message.role === "user") {
			if (typeof message.content === "string") {
				if (message.content.trim().length > 0) blocks.push({ type: "text", text: message.content });
				continue;
			}
			// Preserve part order: adjacent text parts merge, images stay in place.
			let text = "";
			for (const block of message.content) {
				if (block.type === "text") {
					text += block.text;
					continue;
				}
				if (!supportsImages) continue;
				if (text.trim().length > 0) {
					blocks.push({ type: "text", text });
					text = "";
				}
				blocks.push({ type: "image", data: block.data, mimeType: block.mimeType });
			}
			if (text.trim().length > 0) blocks.push({ type: "text", text });
			continue;
		}
		if (message.role === "assistant") {
			const text = assistantText(message);
			if (text.length > 0) blocks.push({ type: "text", text: `Assistant: ${text}` });
			continue;
		}
		blocks.push(...toolResultBlocks(message, supportsImages));
	}
	return blocks;
}
