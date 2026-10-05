import type * as acp from "@agentclientprotocol/sdk";
import { fetchAcpSessionInfo } from "../acp/api.lazy.ts";
import { type AcpChatModelDefinition, createAcpProvider } from "../acp/provider.ts";
import type { Provider, RefreshModelsContext } from "../models.ts";
import type { Model } from "../types.ts";

const DEVIN_COMMAND = "devin";
const DEVIN_ACP_ARGS = ["acp"];

/** Offline baseline: model families (stable slugs). Refresh replaces this with the live variant catalog. */
const BASELINE_MODELS: AcpChatModelDefinition[] = [
	{
		id: "adaptive",
		name: "Adaptive",
		input: ["text", "image"],
		transport: { args: [...DEVIN_ACP_ARGS, "--model", "adaptive"] },
	},
	{ id: "swe-2", name: "SWE-2", reasoning: true, transport: { args: [...DEVIN_ACP_ARGS, "--model", "swe-2"] } },
	{
		id: "swe-2-medium",
		name: "SWE-2 Medium",
		reasoning: true,
		transport: { args: [...DEVIN_ACP_ARGS, "--model", "swe-2-medium"] },
	},
	{
		id: "swe-2-max",
		name: "SWE-2 Max",
		reasoning: true,
		transport: { args: [...DEVIN_ACP_ARGS, "--model", "swe-2-max"] },
	},
	{
		id: "swe-1.7-lightning",
		name: "SWE-1.7 Lightning",
		transport: { args: [...DEVIN_ACP_ARGS, "--model", "swe-1.7-lightning"] },
	},
	{
		id: "claude-fable-5.1",
		name: "Claude Fable 5.1",
		transport: { args: [...DEVIN_ACP_ARGS, "--model", "claude-fable-5.1"] },
	},
	{
		id: "claude-opus-5.5",
		name: "Claude Opus 5.5",
		transport: { args: [...DEVIN_ACP_ARGS, "--model", "claude-opus-5.5"] },
	},
	{ id: "gpt-6-astra", name: "GPT-6 Astra", transport: { args: [...DEVIN_ACP_ARGS, "--model", "gpt-6-astra"] } },
	{ id: "gpt-6-sol", name: "GPT-6 Sol", transport: { args: [...DEVIN_ACP_ARGS, "--model", "gpt-6-sol"] } },
	{ id: "gpt-6-luna", name: "GPT-6 Luna", transport: { args: [...DEVIN_ACP_ARGS, "--model", "gpt-6-luna"] } },
	{ id: "kimi-k3", name: "Kimi K3", transport: { args: [...DEVIN_ACP_ARGS, "--model", "kimi-k3"] } },
	{ id: "glm-5.2", name: "GLM-5.2", transport: { args: [...DEVIN_ACP_ARGS, "--model", "glm-5.2"] } },
	{ id: "glm-5.3", name: "GLM-5.3", transport: { args: [...DEVIN_ACP_ARGS, "--model", "glm-5.3"] } },
	{
		id: "claude-sonnet-5.5",
		name: "Claude Sonnet 5.5",
		transport: { args: [...DEVIN_ACP_ARGS, "--model", "claude-sonnet-5.5"] },
	},
	{
		id: "gemini-3.8-flash",
		name: "Gemini 3.8 Flash",
		transport: { args: [...DEVIN_ACP_ARGS, "--model", "gemini-3.8-flash"] },
	},
	{
		id: "claude-opus-4.7",
		name: "Claude Opus 4.7",
		transport: { args: [...DEVIN_ACP_ARGS, "--model", "claude-opus-4.7"] },
	},
	{
		id: "claude-opus-4.8",
		name: "Claude Opus 4.8",
		transport: { args: [...DEVIN_ACP_ARGS, "--model", "claude-opus-4.8"] },
	},
	{ id: "claude-opus-5", name: "Claude Opus 5", transport: { args: [...DEVIN_ACP_ARGS, "--model", "claude-opus-5"] } },
	{
		id: "claude-fable-5",
		name: "Claude Fable 5",
		transport: { args: [...DEVIN_ACP_ARGS, "--model", "claude-fable-5"] },
	},
	{
		id: "claude-sonnet-5",
		name: "Claude Sonnet 5",
		transport: { args: [...DEVIN_ACP_ARGS, "--model", "claude-sonnet-5"] },
	},
	{
		id: "gemini-3.5-flash",
		name: "Gemini 3.5 Flash",
		transport: { args: [...DEVIN_ACP_ARGS, "--model", "gemini-3.5-flash"] },
	},
	{
		id: "gemini-3.6-flash",
		name: "Gemini 3.6 Flash",
		transport: { args: [...DEVIN_ACP_ARGS, "--model", "gemini-3.6-flash"] },
	},
	{
		id: "gemini-3.7-flash",
		name: "Gemini 3.7 Flash",
		transport: { args: [...DEVIN_ACP_ARGS, "--model", "gemini-3.7-flash"] },
	},
	{ id: "gpt-5.6-sol", name: "GPT-5.6 Sol", transport: { args: [...DEVIN_ACP_ARGS, "--model", "gpt-5.6-sol"] } },
	{ id: "gpt-5.6-terra", name: "GPT-5.6 Terra", transport: { args: [...DEVIN_ACP_ARGS, "--model", "gpt-5.6-terra"] } },
	{ id: "gpt-5.6-luna", name: "GPT-5.6 Luna", transport: { args: [...DEVIN_ACP_ARGS, "--model", "gpt-5.6-luna"] } },
	{ id: "gpt-6.1-sol", name: "GPT-6.1 Sol", transport: { args: [...DEVIN_ACP_ARGS, "--model", "gpt-6.1-sol"] } },
	{ id: "grok-4.5", name: "Grok 4.5", transport: { args: [...DEVIN_ACP_ARGS, "--model", "grok-4.5"] } },
	{ id: "grok-4.6", name: "Grok 4.6", transport: { args: [...DEVIN_ACP_ARGS, "--model", "grok-4.6"] } },
	{ id: "grok-4.7", name: "Grok 4.7", transport: { args: [...DEVIN_ACP_ARGS, "--model", "grok-4.7"] } },
	{ id: "inkling", name: "Inkling", transport: { args: [...DEVIN_ACP_ARGS, "--model", "inkling"] } },
	{ id: "glm-5.3-flash", name: "GLM-5.3 Flash", transport: { args: [...DEVIN_ACP_ARGS, "--model", "glm-5.3-flash"] } },
	{
		id: "deepseek-v4-flash",
		name: "DeepSeek V4 Flash",
		transport: { args: [...DEVIN_ACP_ARGS, "--model", "deepseek-v4-flash"] },
	},
	{
		id: "deepseek-v4.1-flash",
		name: "DeepSeek V4.1 Flash",
		transport: { args: [...DEVIN_ACP_ARGS, "--model", "deepseek-v4.1-flash"] },
	},
	{ id: "swe-1.7", name: "SWE-1.7", transport: { args: [...DEVIN_ACP_ARGS, "--model", "swe-1.7"] } },
	{ id: "fusion", name: "Fusion", transport: { args: [...DEVIN_ACP_ARGS, "--model", "fusion"] } },
	{
		id: "claude-opus-4.6",
		name: "Claude Opus 4.6",
		transport: { args: [...DEVIN_ACP_ARGS, "--model", "claude-opus-4.6"] },
	},
	{ id: "gpt-5.4", name: "GPT-5.4", transport: { args: [...DEVIN_ACP_ARGS, "--model", "gpt-5.4"] } },
	{ id: "gpt-5.5", name: "GPT-5.5", transport: { args: [...DEVIN_ACP_ARGS, "--model", "gpt-5.5"] } },
	{ id: "gpt-5.4-mini", name: "GPT-5.4 Mini", transport: { args: [...DEVIN_ACP_ARGS, "--model", "gpt-5.4-mini"] } },
	{
		id: "claude-sonnet-4.6",
		name: "Claude Sonnet 4.6",
		transport: { args: [...DEVIN_ACP_ARGS, "--model", "claude-sonnet-4.6"] },
	},
	{ id: "gpt-5.2", name: "GPT-5.2", transport: { args: [...DEVIN_ACP_ARGS, "--model", "gpt-5.2"] } },
	{
		id: "claude-opus-4.5",
		name: "Claude Opus 4.5",
		transport: { args: [...DEVIN_ACP_ARGS, "--model", "claude-opus-4.5"] },
	},
	{
		id: "claude-haiku-4.5",
		name: "Claude Haiku 4.5",
		transport: { args: [...DEVIN_ACP_ARGS, "--model", "claude-haiku-4.5"] },
	},
	{ id: "gpt-4.1", name: "GPT-4.1", transport: { args: [...DEVIN_ACP_ARGS, "--model", "gpt-4.1"] } },
	{ id: "gpt-5.1", name: "GPT-5.1", transport: { args: [...DEVIN_ACP_ARGS, "--model", "gpt-5.1"] } },
	{ id: "gpt-5.3-codex", name: "GPT-5.3-Codex", transport: { args: [...DEVIN_ACP_ARGS, "--model", "gpt-5.3-codex"] } },
	{ id: "kimi-k2.6", name: "Kimi K2.6", transport: { args: [...DEVIN_ACP_ARGS, "--model", "kimi-k2.6"] } },
	{ id: "kimi-k2.7", name: "Kimi K2.7", transport: { args: [...DEVIN_ACP_ARGS, "--model", "kimi-k2.7"] } },
	{
		id: "nemotron-3-ultra",
		name: "Nemotron 3 Ultra",
		transport: { args: [...DEVIN_ACP_ARGS, "--model", "nemotron-3-ultra"] },
	},
	{ id: "swe-1.6", name: "SWE-1.6", transport: { args: [...DEVIN_ACP_ARGS, "--model", "swe-1.6"] } },
	{ id: "swe-1.6-fast", name: "SWE-1.6 Fast", transport: { args: [...DEVIN_ACP_ARGS, "--model", "swe-1.6-fast"] } },
	{
		id: "gemini-3.1-pro",
		name: "Gemini 3.1 Pro",
		transport: { args: [...DEVIN_ACP_ARGS, "--model", "gemini-3.1-pro"] },
	},
	{
		id: "gemini-3-flash",
		name: "Gemini 3 Flash",
		transport: { args: [...DEVIN_ACP_ARGS, "--model", "gemini-3-flash"] },
	},
	{
		id: "deepseek-v4-pro",
		name: "DeepSeek V4 Pro",
		transport: { args: [...DEVIN_ACP_ARGS, "--model", "deepseek-v4-pro"] },
	},
];

/** Family aliases (`--model` accepts slugs, aliases, and partial names). */
const BASELINE_ALIASES: AcpChatModelDefinition[] = [
	{ id: "swe", name: "SWE-2 (alias)", reasoning: true, transport: { args: [...DEVIN_ACP_ARGS, "--model", "swe"] } },
	{ id: "fable", name: "Claude Fable 5.1 (alias)", transport: { args: [...DEVIN_ACP_ARGS, "--model", "fable"] } },
	{ id: "gemini", name: "Gemini 3.8 Flash (alias)", transport: { args: [...DEVIN_ACP_ARGS, "--model", "gemini"] } },
	{ id: "opus", name: "Claude Opus 5 (alias)", transport: { args: [...DEVIN_ACP_ARGS, "--model", "opus"] } },
	{ id: "claude", name: "Claude Sonnet 5 (alias)", transport: { args: [...DEVIN_ACP_ARGS, "--model", "claude"] } },
	{ id: "sonnet", name: "Claude Sonnet 5 (alias)", transport: { args: [...DEVIN_ACP_ARGS, "--model", "sonnet"] } },
	{ id: "gpt", name: "GPT-5.5 (alias)", transport: { args: [...DEVIN_ACP_ARGS, "--model", "gpt"] } },
	{ id: "codex", name: "GPT-5.3-Codex (alias)", transport: { args: [...DEVIN_ACP_ARGS, "--model", "codex"] } },
];

const BASELINE_WITH_ALIASES: AcpChatModelDefinition[] = [...BASELINE_MODELS, ...BASELINE_ALIASES];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** Devin thinking tiers (low/medium/high/xhigh/max); `none` and untiered ids are non-reasoning. */
function hasThinkingTier(id: string): boolean {
	return /-(low|medium|high|xhigh|max)(-|$)/.test(id);
}

function imageCapable(meta: unknown): boolean {
	if (!isRecord(meta)) return false;
	return Object.entries(meta).some(([key, value]) => value === true && key.toLowerCase().includes("image"));
}

/**
 * Map an ACP `model`/`model_config` select option to pi chat models.
 * Pure and agent-agnostic apart from the Devin image-capability hint:
 * unknown pricing/context metadata means zero cost and a conservative window.
 */
export function devinModelsFromConfigOptions(
	providerId: string,
	options: readonly acp.SessionConfigOption[] | null | undefined,
): Model<"acp">[] {
	const select = options?.find(
		(option) =>
			option.type === "select" &&
			(option.category === "model" || option.category === "model_config" || option.id === "model"),
	);
	if (!select || select.type !== "select") return [];
	const flat: acp.SessionConfigSelectOption[] = [];
	for (const entry of select.options) {
		if ("value" in entry) flat.push(entry as acp.SessionConfigSelectOption);
		else if (isRecord(entry) && Array.isArray((entry as { options?: unknown }).options)) {
			for (const nested of (entry as { options: unknown[] }).options) {
				if (isRecord(nested) && typeof nested.value === "string")
					flat.push(nested as unknown as acp.SessionConfigSelectOption);
			}
		}
	}
	const seen = new Set<string>();
	const models: Model<"acp">[] = [];
	for (const entry of flat) {
		if (typeof entry.value !== "string" || entry.value.length === 0 || seen.has(entry.value)) continue;
		seen.add(entry.value);
		models.push({
			id: entry.value,
			name: entry.name || entry.value,
			api: "acp",
			provider: providerId,
			baseUrl: `acp://${providerId}`,
			input: imageCapable((entry as { _meta?: unknown })._meta) ? ["text", "image"] : ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200000,
			maxTokens: 16384,
			reasoning: hasThinkingTier(entry.value),
			acp: { command: DEVIN_COMMAND, args: [...DEVIN_ACP_ARGS, "--model", entry.value] },
		});
	}
	return models;
}

async function fetchDevinModels(context: RefreshModelsContext): Promise<readonly Model<"acp">[]> {
	const info = await fetchAcpSessionInfo({ command: DEVIN_COMMAND, args: DEVIN_ACP_ARGS }, { signal: context.signal });
	const models = devinModelsFromConfigOptions("devin", info.configOptions);
	if (models.length === 0) throw new Error("Devin agent advertised no models");
	return models;
}

/**
 * Devin CLI over ACP (`devin acp`). Authenticate with `devin auth login` or
 * `WINDSURF_API_KEY`. The model catalog is discovered dynamically from the
 * agent-advertised ACP session config; offline startup keeps the last snapshot
 * (baseline: Adaptive).
 */
export function devinProvider(): Provider<"acp"> {
	return createAcpProvider({
		id: "devin",
		name: "Devin",
		transport: { command: DEVIN_COMMAND, args: DEVIN_ACP_ARGS },
		models: BASELINE_WITH_ALIASES,
		fetchModels: fetchDevinModels,
	});
}
