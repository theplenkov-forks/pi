import type * as acp from "@agentclientprotocol/sdk";
import { fetchAcpSessionInfo } from "../acp/api.lazy.ts";
import { createAcpProvider } from "../acp/provider.ts";
import type { Provider, RefreshModelsContext } from "../models.ts";
import type { Model, ProviderEnv } from "../types.ts";
import { DEVIN_ACP_ARGS, DEVIN_BASELINE_MODELS, DEVIN_COMMAND } from "./devin-catalog.ts";

/**
 * Limits used when the agent advertises no metadata. Shared with the offline
 * baseline so a model's reported limits do not change at the first refresh.
 */
export const DEVIN_CONTEXT_WINDOW = 200000;
export const DEVIN_MAX_TOKENS = 16384;

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
	for (const entry of select.options as unknown[]) {
		// Narrow before reading: a malformed agent option must not abort discovery.
		if (!isRecord(entry)) continue;
		if (typeof entry.value === "string") {
			flat.push(entry as unknown as acp.SessionConfigSelectOption);
			continue;
		}
		if (!Array.isArray(entry.options)) continue;
		for (const nested of entry.options) {
			if (isRecord(nested) && typeof nested.value === "string")
				flat.push(nested as unknown as acp.SessionConfigSelectOption);
		}
	}
	const seen = new Set<string>();
	// The offline baseline already declares some ids (with curated reasoning and
	// window values). Reusing its flags keeps a model's reported capabilities
	// identical before and after a refresh, which replaces the baseline.
	const baseline = new Map(DEVIN_BASELINE_MODELS.map((entry) => [entry.id, entry]));
	const models: Model<"acp">[] = [];
	for (const entry of flat) {
		if (typeof entry.value !== "string" || entry.value.length === 0 || seen.has(entry.value)) continue;
		seen.add(entry.value);
		const known = baseline.get(entry.value);
		models.push({
			id: entry.value,
			name: entry.name || entry.value,
			api: "acp",
			provider: providerId,
			baseUrl: `acp://${providerId}`,
			input: imageCapable((entry as { _meta?: unknown })._meta) ? ["text", "image"] : ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: known?.contextWindow ?? DEVIN_CONTEXT_WINDOW,
			maxTokens: known?.maxTokens ?? DEVIN_MAX_TOKENS,
			reasoning: known?.reasoning ?? hasThinkingTier(entry.value),
			acp: { command: DEVIN_COMMAND, args: [...DEVIN_ACP_ARGS, "--model", entry.value] },
		});
	}
	return models;
}

async function fetchDevinModels(context: RefreshModelsContext): Promise<readonly Model<"acp">[]> {
	// Discovery authenticates exactly like a request: reuse the resolved
	// credential env so WINDSURF_API_KEY-style auth reaches the agent.
	// OAuthCredentials carries an index signature, so narrow before use.
	const credentialEnv: ProviderEnv | undefined =
		context.credential?.env && typeof context.credential.env === "object"
			? (context.credential.env as ProviderEnv)
			: undefined;
	const info = await fetchAcpSessionInfo(
		{ command: DEVIN_COMMAND, args: DEVIN_ACP_ARGS },
		{ signal: context.signal, env: credentialEnv },
	);
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
		models: DEVIN_BASELINE_MODELS,
		defaults: { contextWindow: DEVIN_CONTEXT_WINDOW, maxTokens: DEVIN_MAX_TOKENS },
		fetchModels: fetchDevinModels,
		// The agent lists what it serves, so its catalog replaces the offline baseline.
		authoritativeCatalog: true,
	});
}
