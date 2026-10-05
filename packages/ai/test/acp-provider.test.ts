import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { acpChatModel, createAcpProvider } from "../src/acp/provider.ts";
import { ACP_API, acpBaseUrl, formatAcpCommand, resolveAcpTransport } from "../src/acp/types.ts";
import { builtinProviders } from "../src/providers/all.ts";
import { devinProvider } from "../src/providers/devin.ts";

describe("ACP transport config", () => {
	it("resolves model overrides over provider defaults", () => {
		expect(resolveAcpTransport({ command: "devin", args: ["acp"] }, undefined)).toEqual({
			command: "devin",
			args: ["acp"],
		});
		expect(
			resolveAcpTransport(
				{ command: "devin", args: ["acp"], env: { A: "1" } },
				{ args: ["acp", "--model", "opus"] },
			),
		).toEqual({ command: "devin", args: ["acp", "--model", "opus"], env: { A: "1" } });
		expect(resolveAcpTransport(undefined, undefined)).toBeUndefined();
		expect(resolveAcpTransport(undefined, {})).toBeUndefined();
	});

	it("formats commands for error messages without leaking argument values", () => {
		expect(formatAcpCommand({ command: "devin", args: ["acp"] })).toBe("devin …");
		expect(formatAcpCommand({ command: "devin", args: ["acp", "--model", "swe-2"] })).toBe("devin … --model …");
		// Argument values can carry secrets, so only flag names survive.
		expect(formatAcpCommand({ command: "agent", args: ["--token", "sk-secret"] })).toBe("agent --token …");
		// `--token=value` carries the secret inline.
		expect(formatAcpCommand({ command: "agent", args: ["--token=sk-secret"] })).toBe("agent --token=…");
		expect(formatAcpCommand({ command: "agent" })).toBe("agent");
		expect(acpBaseUrl("devin")).toBe("acp://devin");
		expect(ACP_API).toBe("acp");
	});
});

describe("createAcpProvider", () => {
	it("builds chat models carrying their resolved transport", () => {
		const provider = createAcpProvider({
			id: "custom",
			transport: { command: "my-agent", args: ["--acp"] },
			models: [{ id: "default" }, { id: "fast", transport: { args: ["--acp", "--fast"] } }],
		});
		expect(provider.id).toBe("custom");
		expect(provider.getModels().map((model) => [model.id, model.api, model.acp])).toEqual([
			["default", "acp", { command: "my-agent", args: ["--acp"] }],
			["fast", "acp", { command: "my-agent", args: ["--acp", "--fast"] }],
		]);
		expect(provider.auth.apiKey).toBeDefined();
		expect(provider.auth.apiKey?.login).toBeUndefined();
	});

	it("rejects models without a command", () => {
		expect(() => acpChatModel("custom", { command: "" }, { id: "x" })).toThrow("no command");
	});
});

describe("devinProvider", () => {
	it("uses devin acp defaults with ambient auth", async () => {
		const provider = devinProvider();
		expect(provider.id).toBe("devin");
		const models = provider.getModels();
		expect(models).toHaveLength(63);
		expect(models[0]?.id).toBe("adaptive");
		expect(models[0]?.acp).toEqual({ command: "devin", args: ["acp", "--model", "adaptive"] });
		expect(provider.auth.apiKey?.login).toBeUndefined();
		expect(typeof provider.refreshModels).toBe("function");
		// Unresolvable command: unconfigured, not broken. An empty directory as
		// PATH keeps the result independent of the ambient environment (an empty
		// PATH string would search the current directory instead).
		const { acpCommandAuth: checkAuth } = await import("../src/acp/provider.ts");
		const missing = checkAuth(
			"Devin",
			() => "no-such-acp-binary-xyz",
			() => ({ PATH: mkdtempSync(join(tmpdir(), "acp-empty-")) }),
		);
		expect(
			await missing.check?.({
				ctx: { env: async () => undefined, fileExists: async () => false },
				signal: new AbortController().signal,
			}),
		).toBeUndefined();
	});

	it("maps ACP model config options to chat models", async () => {
		const { devinModelsFromConfigOptions } = await import("../src/providers/devin.ts");
		const models = devinModelsFromConfigOptions("devin", [
			{
				id: "model",
				name: "Model",
				category: "model",
				type: "select",
				currentValue: "adaptive",
				options: [
					{ value: "adaptive", name: "Adaptive", _meta: { "cognition.ai/supportsImages": true } },
					{ value: "swe-2-high", name: "SWE-2" },
					{ value: "gpt-6-sol-none", name: "GPT-6 Sol No Thinking" },
					{ value: "", name: "Empty" },
					{ value: "adaptive", name: "Adaptive duplicate" },
					// Grouped options flatten to their nested entries.
					{ name: "Group", options: [{ value: "grouped-model", name: "Grouped" }] } as never,
					// A non-object entry must not abort discovery.
					"bogus" as never,
				],
			},
		]);
		expect(models.map((model) => [model.id, model.name, model.input, model.reasoning, model.acp?.args])).toEqual([
			["adaptive", "Adaptive", ["text", "image"], false, ["acp", "--model", "adaptive"]],
			["swe-2-high", "SWE-2", ["text"], true, ["acp", "--model", "swe-2-high"]],
			["gpt-6-sol-none", "GPT-6 Sol No Thinking", ["text"], false, ["acp", "--model", "gpt-6-sol-none"]],
			["grouped-model", "Grouped", ["text"], false, ["acp", "--model", "grouped-model"]],
		]);
	});

	it("ignores non-model config and empty options", async () => {
		const { devinModelsFromConfigOptions } = await import("../src/providers/devin.ts");
		expect(devinModelsFromConfigOptions("devin", undefined)).toEqual([]);
		expect(
			devinModelsFromConfigOptions("devin", [
				{ id: "mode", name: "Mode", category: "mode", type: "select", currentValue: "x", options: [] },
			]),
		).toEqual([]);
	});

	it("is registered as a builtin provider", () => {
		const ids = builtinProviders().map((provider) => provider.id);
		expect(ids).toContain("devin");
	});
});
