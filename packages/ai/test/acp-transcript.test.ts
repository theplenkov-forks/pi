import { describe, expect, it } from "vitest";
import { transcriptToAcpPrompt } from "../src/acp/transcript.ts";
import type { Message } from "../src/types.ts";

const timestamp = 1700000000000;

describe("transcriptToAcpPrompt", () => {
	it("prepends the system prompt once and converts a user text message", () => {
		const messages: Message[] = [{ role: "user", content: "Fix the bug", timestamp }];
		const blocks = transcriptToAcpPrompt(messages, { systemPrompt: "You are pi." });
		expect(blocks).toEqual([
			{ type: "text", text: "You are pi." },
			{ type: "text", text: "Fix the bug" },
		]);
	});

	it("omits the system prompt when not provided and skips system messages", () => {
		const messages: Message[] = [
			{ role: "system", content: "base prompt", timestamp },
			{ role: "user", content: "Hello", timestamp },
		];
		expect(transcriptToAcpPrompt(messages)).toEqual([{ type: "text", text: "Hello" }]);
	});

	it("keeps interleaved text and image parts in order", () => {
		const messages: Message[] = [
			{
				role: "user",
				content: [
					{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
					{ type: "text", text: "before" },
					{ type: "text", text: " after" },
					{ type: "image", data: "d29ybGQ=", mimeType: "image/jpeg" },
					{ type: "text", text: "tail" },
				],
				timestamp,
			},
		];
		expect(transcriptToAcpPrompt(messages)).toEqual([
			{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
			{ type: "text", text: "before after" },
			{ type: "image", data: "d29ybGQ=", mimeType: "image/jpeg" },
			{ type: "text", text: "tail" },
		]);
	});

	it("splits image parts into image blocks after the message text", () => {
		const messages: Message[] = [
			{
				role: "user",
				content: [
					{ type: "text", text: "Describe this" },
					{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
				],
				timestamp,
			},
		];
		expect(transcriptToAcpPrompt(messages)).toEqual([
			{ type: "text", text: "Describe this" },
			{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
		]);
	});

	it("renders assistant and tool history as quoted text for model switches", () => {
		const messages: Message[] = [
			{
				role: "assistant",
				content: [
					{ type: "text", text: "Reading the file." },
					{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "a.txt" } },
				],
				api: "openai-completions",
				provider: "openai",
				model: "gpt",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp,
			},
			{
				role: "toolResult",
				toolCallId: "call_1",
				toolName: "read",
				content: [{ type: "text", text: "file contents" }],
				isError: false,
				timestamp,
			},
			{ role: "user", content: "Continue", timestamp },
		];
		const blocks = transcriptToAcpPrompt(messages);
		expect(blocks[0]).toEqual({
			type: "text",
			text: 'Assistant: Reading the file.\n\nTool call `read`: {"path":"a.txt"}',
		});
		expect(blocks[1]).toEqual({ type: "text", text: "Tool result `read`: file contents" });
		expect(blocks[2]).toEqual({ type: "text", text: "Continue" });
	});

	it("keeps tool-result parts in source order", () => {
		const messages: Message[] = [
			{
				role: "toolResult",
				toolCallId: "call_1",
				toolName: "screenshot",
				content: [
					{ type: "text", text: "before" },
					{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
					{ type: "text", text: "after" },
				],
				isError: false,
				timestamp,
			},
		];
		// The label goes on the first text, and the image stays between the texts.
		expect(transcriptToAcpPrompt(messages)).toEqual([
			{ type: "text", text: "Tool result `screenshot`: before" },
			{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
			{ type: "text", text: "after" },
		]);
	});

	it("labels an image-only tool result and notes a filtered image", () => {
		const messages: Message[] = [
			{
				role: "toolResult",
				toolCallId: "call_1",
				toolName: "shot",
				content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
				isError: true,
				timestamp,
			},
		];
		expect(transcriptToAcpPrompt(messages)).toEqual([
			{ type: "text", text: "Tool error `shot`:" },
			{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
		]);
		expect(transcriptToAcpPrompt(messages, { supportsImages: false })).toEqual([
			{ type: "text", text: "Tool error `shot`: (image omitted: model does not accept images)" },
		]);
	});

	it("keeps assistant thinking and tool-result images in replayed history", () => {
		const messages: Message[] = [
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "considering" },
					{ type: "text", text: "Done." },
				],
				api: "openai-completions",
				provider: "openai",
				model: "gpt",
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
			},
			{
				role: "toolResult",
				toolCallId: "call_1",
				toolName: "screenshot",
				content: [
					{ type: "text", text: "captured" },
					{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
				],
				isError: false,
				timestamp,
			},
		];
		expect(transcriptToAcpPrompt(messages)).toEqual([
			{ type: "text", text: "Assistant: Thinking: considering\n\nDone." },
			{ type: "text", text: "Tool result `screenshot`: captured" },
			{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
		]);
		// A text-only agent must not receive image blocks, but must still learn
		// that the tool produced one.
		expect(transcriptToAcpPrompt(messages, { supportsImages: false })).toEqual([
			{ type: "text", text: "Assistant: Thinking: considering\n\nDone." },
			{ type: "text", text: "Tool result `screenshot`: captured (image omitted: model does not accept images)" },
		]);
	});

	it("sends the system prompt verbatim but skips a whitespace-only one", () => {
		expect(transcriptToAcpPrompt([], { systemPrompt: "  padded prompt  " })).toEqual([
			{ type: "text", text: "  padded prompt  " },
		]);
		expect(transcriptToAcpPrompt([], { systemPrompt: "   " })).toEqual([]);
	});

	it("skips empty user messages", () => {
		const messages: Message[] = [
			{ role: "user", content: "   ", timestamp },
			{ role: "user", content: "Real", timestamp },
		];
		expect(transcriptToAcpPrompt(messages)).toEqual([{ type: "text", text: "Real" }]);
	});

	it("returns no blocks for history without user-visible content", () => {
		const messages: Message[] = [{ role: "system", content: "prompt", timestamp }];
		expect(transcriptToAcpPrompt(messages)).toEqual([]);
	});
});
