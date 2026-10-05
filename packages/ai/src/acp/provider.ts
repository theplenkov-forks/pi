/**
 * Generic ACP provider factory. Any ACP-compatible CLI becomes a pi provider
 * through `createAcpProvider` with its `command`/`args`/`env`.
 *
 * Streaming and auth load their Node implementations through bundler-opaque
 * dynamic imports, so this module stays browser-safe (it ships in the
 * provider chain bundled for browser smoke builds). The Bun binary build
 * registers static modules instead (see `api.lazy.ts`, `runtime-setup.ts`).
 */

import type { ApiKeyAuth } from "../auth/types.ts";
import { createProvider, type Provider, type RefreshModelsContext } from "../models.ts";
import type { Model, ModelCost } from "../types.ts";
import { acpApi } from "./api.lazy.ts";
import { type AcpTransportConfig, acpBaseUrl, resolveAcpTransport } from "./types.ts";

type AcpAuthModule = typeof import("./auth.ts");

const importNodeOnlyAuth = (specifier: string): Promise<AcpAuthModule> => {
	const runtimeSpecifier = import.meta.url.endsWith(".js") ? specifier.replace(/\.ts$/, ".js") : specifier;
	return import(runtimeSpecifier) as Promise<AcpAuthModule>;
};

let acpAuthModuleOverride: AcpAuthModule | undefined;

/** Overrides the dynamically imported ACP auth implementation (Bun binary build). */
export function setAcpAuthModule(module: AcpAuthModule): void {
	acpAuthModuleOverride = module;
}

async function loadAuthModule(): Promise<AcpAuthModule | undefined> {
	if (acpAuthModuleOverride) return acpAuthModuleOverride;
	try {
		return await importNodeOnlyAuth("./auth.ts");
	} catch {
		// Browser builds cannot spawn subprocesses: stay unconfigured.
		return undefined;
	}
}

/** Command-based auth with a lazily loaded binary check. No login flow. */
export function acpCommandAuth(
	name: string,
	getCommand: () => string | undefined,
	getEnv?: () => Record<string, string> | undefined,
): ApiKeyAuth {
	return {
		name,
		check: async (input) => {
			input.signal.throwIfAborted();
			const module = await loadAuthModule();
			if (!module) return undefined;
			return module.checkAcpCommand(getCommand(), input, getEnv?.());
		},
		resolve: async (input) => {
			input.signal.throwIfAborted();
			const module = await loadAuthModule();
			if (!module) return undefined;
			return module.resolveAcpCommand(getCommand(), input, getEnv?.());
		},
	};
}

export interface AcpChatModelDefinition {
	id: string;
	name?: string;
	/** Per-model transport override; defaults to the provider transport. */
	transport?: { command?: string; args?: string[]; env?: Record<string, string> };
	input?: ("text" | "image")[];
	cost?: ModelCost;
	contextWindow?: number;
	maxTokens?: number;
	reasoning?: boolean;
}

export interface AcpProviderOptions {
	id: string;
	name?: string;
	transport: AcpTransportConfig;
	models: AcpChatModelDefinition[];
	/**
	 * Limits applied when a model definition omits them. Shared with dynamic
	 * discovery so a model's reported limits do not change at the first refresh.
	 */
	defaults?: Pick<AcpChatModelDefinition, "input" | "contextWindow" | "maxTokens">;
	/**
	 * Dynamic model discovery (e.g. ACP session config). createProvider
	 * restores the persisted snapshot offline and publishes fetched models.
	 */
	fetchModels?: (context: RefreshModelsContext) => Promise<readonly Model<"acp">[]>;
	/**
	 * Treat `models` as an offline fallback when `fetchModels` is set: the agent
	 * advertises the authoritative catalog, so a successful refresh replaces the
	 * baseline instead of merging with it.
	 */
	authoritativeCatalog?: boolean;
}

function zeroCost(): ModelCost {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

export function acpChatModel(
	providerId: string,
	transport: AcpTransportConfig,
	definition: AcpChatModelDefinition,
	defaults?: Pick<AcpChatModelDefinition, "input" | "contextWindow" | "maxTokens">,
): Model<"acp"> {
	const resolved = resolveAcpTransport(transport, definition.transport);
	if (!resolved) throw new Error(`ACP model ${providerId}/${definition.id} has no command configured`);
	const env = resolved.env && Object.keys(resolved.env).length > 0 ? resolved.env : undefined;
	return {
		id: definition.id,
		name: definition.name ?? definition.id,
		api: "acp",
		provider: providerId,
		baseUrl: acpBaseUrl(providerId),
		input: definition.input ?? defaults?.input ?? ["text"],
		cost: definition.cost ?? zeroCost(),
		contextWindow: definition.contextWindow ?? defaults?.contextWindow ?? 128000,
		maxTokens: definition.maxTokens ?? defaults?.maxTokens ?? 16384,
		reasoning: definition.reasoning ?? false,
		acp: {
			command: resolved.command,
			...(resolved.args !== undefined ? { args: resolved.args } : {}),
			...(env ? { env } : {}),
		},
	};
}

/** Build a generic ACP-backed provider. Transport resolution is per model. */
export function createAcpProvider(options: AcpProviderOptions): Provider<"acp"> {
	const transport = { ...options.transport };
	return createProvider<"acp">({
		id: options.id,
		name: options.name ?? options.id,
		auth: {
			apiKey: acpCommandAuth(
				options.name ?? options.id,
				() => transport.command,
				() => transport.env,
			),
		},
		models: options.models.map((definition) => acpChatModel(options.id, transport, definition, options.defaults)),
		fetchModels: options.fetchModels,
		replaceBaselineOnDynamicCatalog: options.authoritativeCatalog && options.fetchModels !== undefined,
		api: acpApi(),
	});
}
