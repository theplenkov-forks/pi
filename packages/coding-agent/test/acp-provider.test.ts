import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devinProvider } from "@earendil-works/pi-ai/providers/devin";
import { describe, expect, it } from "vitest";
import { ModelConfig } from "../src/core/model-config.ts";
import { composeModelProvider } from "../src/core/provider-composer.ts";

function loadConfig(modelsJson: unknown): Promise<ModelConfig> {
	const dir = mkdtempSync(join(tmpdir(), "acp-models-"));
	const path = join(dir, "models.json");
	writeFileSync(path, JSON.stringify(modelsJson));
	return ModelConfig.load(path);
}

describe("ACP models.json support", () => {
	it("loads command/args/env for providers and models", async () => {
		const config = await loadConfig({
			providers: {
				"my-agent": {
					command: "my-agent",
					args: ["acp"],
					env: { MY_AGENT_KEY: "x" },
					api: "acp",
					models: [{ id: "default" }, { id: "opus", args: ["acp", "--model", "opus"] }],
				},
			},
		});
		expect(config.getError()).toBeUndefined();
		const provider = config.getProvider("my-agent");
		expect(provider?.command).toBe("my-agent");
		expect(provider?.models?.[1]?.args).toEqual(["acp", "--model", "opus"]);
	});

	it("composes a generic ACP provider with per-model transports", async () => {
		const config = await loadConfig({
			providers: {
				"my-agent": {
					command: "my-agent",
					args: ["acp"],
					api: "acp",
					models: [{ id: "default" }, { id: "opus", args: ["acp", "--model", "opus"] }],
				},
			},
		});
		const provider = composeModelProvider("my-agent", undefined, config, undefined);
		expect(provider.id).toBe("my-agent");
		const models = provider.getModels();
		expect(models.map((model) => [model.id, model.api, model.baseUrl])).toEqual([
			["default", "acp", "acp://my-agent"],
			["opus", "acp", "acp://my-agent"],
		]);
		expect(models[0]?.acp).toEqual({ command: "my-agent", args: ["acp"] });
		expect(models[1]?.acp).toEqual({ command: "my-agent", args: ["acp", "--model", "opus"] });
		// No login flow for command-based auth. Unknown binary: unconfigured,
		// composable, and streamable-to-error at spawn time.
		expect(provider.auth.apiKey?.login).toBeUndefined();
		const checked = await provider.auth.apiKey?.check?.({
			ctx: { env: async () => undefined, fileExists: async () => false },
			signal: new AbortController().signal,
		});
		expect(checked).toBeUndefined();
	});

	it("applies modelOverrides to ACP transports", async () => {
		const config = await loadConfig({
			providers: {
				"my-agent": {
					command: "my-agent",
					api: "acp",
					models: [{ id: "default" }],
					modelOverrides: { default: { args: ["acp", "--model", "opus"] } },
				},
			},
		});
		const provider = composeModelProvider("my-agent", undefined, config, undefined);
		expect(provider.getModels()[0]?.acp).toEqual({ command: "my-agent", args: ["acp", "--model", "opus"] });
	});

	it("rejects command combined with oauth", async () => {
		const config = await loadConfig({
			providers: { "my-agent": { command: "my-agent", oauth: "radius", baseUrl: "https://x.example" } },
		});
		expect(() => composeModelProvider("my-agent", undefined, config, undefined)).toThrow("cannot be combined");
	});

	it("rejects transport fields on non-ACP models", async () => {
		const config = await loadConfig({
			providers: {
				ep: {
					baseUrl: "https://x.example/v1",
					api: "openai-completions",
					models: [{ id: "m", command: "x" }],
				},
			},
		});
		expect(() => composeModelProvider("ep", undefined, config, undefined)).toThrow('require "api": "acp"');
	});

	it("filters ACP models with include and exclude", async () => {
		const config = await loadConfig({
			providers: {
				"my-agent": {
					command: "my-agent",
					api: "acp",
					models: [{ id: "swe-2-high" }, { id: "swe-2-max" }, { id: "opus" }, { id: "fusion-x" }],
					exclude: ["fusion-"],
				},
			},
		});
		const ids = composeModelProvider("my-agent", undefined, config, undefined)
			.getModels()
			.map((m) => m.id);
		expect(ids).toEqual(["swe-2-high", "swe-2-max", "opus"]);

		const included = await loadConfig({
			providers: {
				"my-agent": {
					command: "my-agent",
					api: "acp",
					models: [{ id: "swe-2-high" }, { id: "swe-2-max" }, { id: "opus" }],
					include: ["SWE-"],
				},
			},
		});
		expect(
			composeModelProvider("my-agent", undefined, included, undefined)
				.getModels()
				.map((m) => m.id),
		).toEqual(["swe-2-high", "swe-2-max"]);
	});

	it("rejects include/exclude on non-ACP providers", async () => {
		const config = await loadConfig({
			providers: {
				ep: {
					baseUrl: "https://x.example/v1",
					api: "openai-completions",
					exclude: ["x"],
					models: [{ id: "m" }],
				},
			},
		});
		expect(() => composeModelProvider("ep", undefined, config, undefined)).toThrow("require an ACP provider");
	});

	it("keeps the builtin devin transport under models.json overlays", async () => {
		const config = await loadConfig({
			providers: { devin: { models: [{ id: "opus", api: "acp", args: ["acp", "--model", "opus"] }] } },
		});
		const provider = composeModelProvider("devin", devinProvider(), config, undefined);
		const byId = new Map(provider.getModels().map((model) => [model.id, model]));
		expect(byId.get("adaptive")?.acp).toEqual({ command: "devin", args: ["acp", "--model", "adaptive"] });
		expect(byId.get("opus")?.acp).toEqual({ command: "devin", args: ["acp", "--model", "opus"] });
	});
});
