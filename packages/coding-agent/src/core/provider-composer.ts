import {
	type AnyModel,
	type Api,
	type ApiKeyAuth,
	type AssistantMessageEventStream,
	type AuthContext,
	type AuthInteraction,
	type AuthResult,
	acpBaseUrl,
	type ClassifierApi,
	type Credential,
	type ImageApi,
	isModelType,
	lazyStream,
	type Model,
	type ModelAcpTransport,
	type ModelAuth,
	type OAuthAuth,
	type OAuthCredentials,
	type OAuthLoginCallbacks,
	type Provider,
	type ProviderClassifier,
	type ProviderHeaders,
	type ProviderImages,
	type RefreshModelsContext,
	resolveAcpTransport,
	type SimpleStreamOptions,
	type StreamOptions,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { acpCommandAuth } from "@earendil-works/pi-ai/acp/provider";
import { getApiProvider } from "@earendil-works/pi-ai/compat";
import { classifierErrorResult, imageErrorResult } from "@earendil-works/pi-ai/utils/model-operations";
import type { ModelConfig, ModelsJsonModel, ModelsJsonModelOverride, ModelsJsonProvider } from "./model-config.ts";
import {
	clearConfigValueCache,
	getConfigValueEnvVarNames,
	isCommandConfigValue,
	isConfigValueConfigured,
	resolveConfigValueOrThrow,
	resolveHeadersOrThrow,
} from "./resolve-config-value.ts";

export interface ExtensionOAuthConfig {
	name: string;
	/** Whether access through this auth method is backed by a provider subscription. */
	isSubscription?: boolean;
	/** @deprecated Retained for extension source compatibility; ignored by canonical auth flows. */
	usesCallbackServer?: boolean;
	login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials>;
	refreshToken(credentials: OAuthCredentials, signal: AbortSignal): Promise<OAuthCredentials>;
	getApiKey(credentials: OAuthCredentials): string;
	modifyModels?(models: Model<Api>[], credentials: OAuthCredentials): Model<Api>[];
}

interface ProviderModelConfigBase {
	id: string;
	name: string;
	api?: string;
	baseUrl?: string;
	input: ("text" | "image")[];
	inputLimits?: AnyModel["inputLimits"];
	cost: AnyModel["cost"];
	headers?: Record<string, string>;
}

export interface ProviderChatModelConfig extends ProviderModelConfigBase {
	type?: "chat";
	api?: Api;
	reasoning: boolean;
	thinkingLevelMap?: Model<Api>["thinkingLevelMap"];
	promptCache?: Model<Api>["promptCache"];
	contextWindow: number;
	maxTokens: number;
	samplingParams?: Model<Api>["samplingParams"];
	samplingParamsByThinkingLevel?: Model<Api>["samplingParamsByThinkingLevel"];
	compat?: Model<Api>["compat"];
}

export interface ProviderImageModelConfig extends ProviderModelConfigBase {
	type: "image";
	api?: ImageApi;
	output: ("text" | "image")[];
}

export interface ProviderClassifierModelConfig extends ProviderModelConfigBase {
	type: "classifier";
	api?: ClassifierApi;
	contextWindow: number;
}

export type ProviderModelConfig = ProviderChatModelConfig | ProviderImageModelConfig | ProviderClassifierModelConfig;

/** Input type for the extension registerProvider API. */
export interface ProviderConfigInput {
	name?: string;
	baseUrl?: string;
	apiKey?: string;
	api?: Api;
	streamSimple?: (
		model: Model<Api>,
		context: TranscriptContext,
		options?: SimpleStreamOptions,
	) => AssistantMessageEventStream;
	images?: Partial<Record<ImageApi, ProviderImages>>;
	classifiers?: Partial<Record<ClassifierApi, ProviderClassifier>>;
	headers?: Record<string, string>;
	authHeader?: boolean;
	oauth?: ExtensionOAuthConfig;
	models?: ProviderModelConfig[];
	refreshModels?(context: RefreshModelsContext): Promise<ProviderModelConfig[]>;
}

export type AuthStatus = {
	configured: boolean;
	source?: "stored" | "runtime" | "environment" | "fallback" | "models_json_key" | "models_json_command";
	label?: string;
};

export const clearApiKeyCache = clearConfigValueCache;

function getAllProviderModels(provider: Provider | undefined): readonly AnyModel[] {
	return provider ? (provider.getAllModels?.() ?? provider.getModels()) : [];
}

function mergeCompat(
	base: Model<Api>["compat"],
	override: Model<Api>["compat"] | ModelsJsonModelOverride["compat"],
): Model<Api>["compat"] {
	if (!override) return base;
	const merged = { ...base, ...override } as NonNullable<Model<Api>["compat"]>;
	const baseNested = base as Record<string, unknown> | undefined;
	const overrideNested = override as Record<string, unknown>;
	const mergedNested = merged as Record<string, unknown>;
	for (const key of ["openRouterRouting", "vercelGatewayRouting", "chatTemplateKwargs", "chatTemplateArgs"] as const) {
		const baseValue = baseNested?.[key];
		const overrideValue = overrideNested[key];
		if (
			(typeof baseValue === "object" && baseValue !== null) ||
			(typeof overrideValue === "object" && overrideValue !== null)
		) {
			mergedNested[key] = { ...(baseValue as object | undefined), ...(overrideValue as object | undefined) };
		}
	}
	return merged;
}

function mergeInputLimits(
	base: Model<Api>["inputLimits"],
	override: ModelsJsonModelOverride["inputLimits"],
): Model<Api>["inputLimits"] {
	if (!override) return base;
	return {
		...base,
		...override,
		images: override.images
			? {
					...base?.images,
					...override.images,
					resize: override.images.resize
						? { ...base?.images?.resize, ...override.images.resize }
						: base?.images?.resize,
				}
			: base?.images,
	};
}

function mergeSamplingParamsByThinkingLevel(
	base: Model<Api>["samplingParamsByThinkingLevel"],
	override: Model<Api>["samplingParamsByThinkingLevel"],
): Model<Api>["samplingParamsByThinkingLevel"] {
	if (!override) return base;
	const merged = { ...base };
	for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const) {
		const params = override[level];
		if (params) merged[level] = { ...base?.[level], ...params };
	}
	return merged;
}

function applyModelOverride(model: Model<Api>, override: ModelsJsonModelOverride): Model<Api> {
	const acp =
		override.command !== undefined || override.args !== undefined || override.env !== undefined
			? {
					...model.acp,
					...(override.command !== undefined ? { command: override.command } : {}),
					...(override.args !== undefined ? { args: override.args } : {}),
					...(override.env !== undefined ? { env: { ...model.acp?.env, ...override.env } } : {}),
				}
			: model.acp;
	return {
		...model,
		...(acp !== undefined ? { acp } : {}),
		name: override.name ?? model.name,
		reasoning: override.reasoning ?? model.reasoning,
		thinkingLevelMap: override.thinkingLevelMap
			? { ...model.thinkingLevelMap, ...override.thinkingLevelMap }
			: model.thinkingLevelMap,
		input: (override.input as ("text" | "image")[] | undefined) ?? model.input,
		inputLimits: mergeInputLimits(model.inputLimits, override.inputLimits),
		cost: override.cost
			? {
					input: override.cost.input ?? model.cost.input,
					output: override.cost.output ?? model.cost.output,
					cacheRead: override.cost.cacheRead ?? model.cost.cacheRead,
					cacheWrite: override.cost.cacheWrite ?? model.cost.cacheWrite,
					tiers: override.cost.tiers ?? model.cost.tiers,
				}
			: model.cost,
		promptCache: override.promptCache ? { ...model.promptCache, ...override.promptCache } : model.promptCache,
		contextWindow: override.contextWindow ?? model.contextWindow,
		maxTokens: override.maxTokens ?? model.maxTokens,
		samplingParams: override.samplingParams
			? { ...model.samplingParams, ...override.samplingParams }
			: model.samplingParams,
		samplingParamsByThinkingLevel: mergeSamplingParamsByThinkingLevel(
			model.samplingParamsByThinkingLevel,
			override.samplingParamsByThinkingLevel,
		),
		compat: mergeCompat(model.compat, override.compat),
	};
}

function modelFromJson(
	providerId: string,
	definition: ModelsJsonModel,
	providerConfig: ModelsJsonProvider,
	defaults: Model<Api> | undefined,
): Model<Api> {
	const api = definition.api ?? providerConfig.api ?? defaults?.api;
	if (!api) {
		throw new Error(
			`Provider ${providerId}, model ${definition.id}: no "api" specified. Set at provider or model level.`,
		);
	}
	const baseUrl = definition.baseUrl ?? providerConfig.baseUrl ?? defaults?.baseUrl;
	const isAcp = (definition.api ?? providerConfig.api ?? defaults?.api) === "acp";
	if (!baseUrl && !isAcp)
		throw new Error(`Provider ${providerId}: "baseUrl" is required when defining custom models.`);
	if (definition.contextWindow !== undefined && definition.contextWindow <= 0) {
		throw new Error(`Provider ${providerId}, model ${definition.id}: invalid contextWindow`);
	}
	if (definition.maxTokens !== undefined && definition.maxTokens <= 0) {
		throw new Error(`Provider ${providerId}, model ${definition.id}: invalid maxTokens`);
	}
	return {
		id: definition.id,
		name: definition.name ?? definition.id,
		api: api as Api,
		provider: providerId,
		baseUrl: baseUrl ?? acpBaseUrl(providerId),
		reasoning: definition.reasoning ?? false,
		thinkingLevelMap: definition.thinkingLevelMap,
		input: (definition.input ?? ["text"]) as ("text" | "image")[],
		inputLimits: definition.inputLimits,
		cost: definition.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		promptCache: definition.promptCache,
		contextWindow: definition.contextWindow ?? 128000,
		maxTokens: definition.maxTokens ?? 16384,
		samplingParams: definition.samplingParams,
		samplingParamsByThinkingLevel: definition.samplingParamsByThinkingLevel,
		headers: undefined,
		compat: mergeCompat(providerConfig.compat, definition.compat),
		...acpTransportFromJson(providerId, definition, providerConfig, defaults),
	};
}

function acpTransportFromJson(
	providerId: string,
	definition: ModelsJsonModel,
	providerConfig: ModelsJsonProvider,
	defaults: Model<Api> | undefined,
): { acp?: Model<Api>["acp"] } {
	// `defaults` is the matching known model, so an overlay that only renames a
	// built-in ACP model keeps its api and command transport.
	const api = definition.api ?? providerConfig.api ?? defaults?.api;
	if (
		api !== "acp" &&
		definition.command === undefined &&
		definition.args === undefined &&
		definition.env === undefined
	) {
		return {};
	}
	if (api !== "acp") {
		throw new Error(`Provider ${providerId}, model ${definition.id}: "command"/"args"/"env" require "api": "acp".`);
	}
	// Provider-level settings layer over the known model's transport so `env`
	// and `args` apply even when only the command comes from the builtin.
	const providerTransport: ModelAcpTransport = {
		command: providerConfig.command ?? defaults?.acp?.command,
		args: providerConfig.args ?? defaults?.acp?.args,
		env: { ...defaults?.acp?.env, ...providerConfig.env },
	};
	const resolved = resolveAcpTransport(providerTransport, {
		command: definition.command,
		args: definition.args,
		env: definition.env,
	});
	if (!resolved) {
		throw new Error(`Provider ${providerId}, model ${definition.id}: "command" is required for ACP models.`);
	}
	return { acp: resolved };
}

function findModelDefaults(models: readonly AnyModel[], modelId: string, api?: Api): Model<Api> | undefined {
	const chatModels = models.filter((model) => isModelType(model, "chat"));
	return (
		chatModels.find((model) => model.id === modelId) ??
		(api ? chatModels.find((model) => model.api === api) : undefined) ??
		chatModels.find((model) => model.api === "openai-completions") ??
		chatModels[0]
	);
}

function findExtensionModelDefaults(
	models: readonly AnyModel[],
	definition: ProviderModelConfig,
	providerApi?: Api,
): AnyModel | undefined {
	const type = definition.type ?? "chat";
	const effectiveApi = definition.api ?? providerApi;
	const candidates = models.filter((model) => isModelType(model, type));
	return (
		candidates.find((model) => model.id === definition.id && (!effectiveApi || model.api === effectiveApi)) ??
		(effectiveApi ? candidates.find((model) => model.api === effectiveApi) : undefined) ??
		candidates.find((model) => model.id === definition.id) ??
		(type === "chat" ? candidates.find((model) => model.api === "openai-completions") : undefined) ??
		candidates[0]
	);
}

function extensionModelFromDefinition(
	providerId: string,
	models: readonly AnyModel[],
	config: ProviderConfigInput,
	definition: ProviderModelConfig,
): AnyModel {
	const type = definition.type ?? "chat";
	const providerApi = type === "chat" ? config.api : undefined;
	// Provider-level `api: "acp"` decides the api even when the candidate default
	// matches by id only, so select defaults against the effective api.
	const defaults = findExtensionModelDefaults(models, definition, providerApi);
	const api = definition.api ?? providerApi ?? defaults?.api;
	if (!api) {
		throw new Error(
			`Provider ${providerId}, model ${definition.id}: no "api" specified. Set it at model level${type === "chat" ? " or provider level" : ""}.`,
		);
	}
	const baseUrl = definition.baseUrl ?? config.baseUrl ?? defaults?.baseUrl;
	if (!baseUrl) throw new Error(`Provider ${providerId}: "baseUrl" is required when defining custom models.`);
	// Extension registrations carry no ACP transport; ACP models keep the base model's transport.
	const inheritedAcp = api === "acp" && defaults && "acp" in defaults ? { acp: defaults.acp } : {};
	if (definition.type === "image") {
		return { ...definition, api: api as ImageApi, provider: providerId, baseUrl, headers: undefined };
	}
	if (definition.type === "classifier") {
		return { ...definition, api: api as ClassifierApi, provider: providerId, baseUrl, headers: undefined };
	}
	return { ...definition, api: api as Api, provider: providerId, baseUrl, headers: undefined, ...inheritedAcp };
}

function applyModelsJson(
	providerId: string,
	baseModels: readonly AnyModel[],
	config: ModelsJsonProvider | undefined,
): AnyModel[] {
	if (!config) return [...baseModels];
	if (config.oauth && !config.baseUrl) {
		throw new Error(`Provider ${providerId}: "baseUrl" is required when "oauth" is set.`);
	}
	const hasOverrides = config.modelOverrides && Object.keys(config.modelOverrides).length > 0;
	if (
		!config.models?.length &&
		!config.baseUrl &&
		!config.command &&
		!config.headers &&
		!config.compat &&
		!hasOverrides &&
		!config.apiKey &&
		!config.oauth &&
		!config.include?.length &&
		!config.exclude?.length &&
		config.authHeader === undefined
	) {
		throw new Error(
			`Provider ${providerId}: must specify "baseUrl", "command", "headers", "compat", "modelOverrides", "include"/"exclude", or "models".`,
		);
	}

	const models: AnyModel[] = baseModels.map((model) => {
		const baseUrl = config.oauth === "radius" ? model.baseUrl : (config.baseUrl ?? model.baseUrl);
		return isModelType(model, "chat")
			? { ...model, baseUrl, compat: mergeCompat(model.compat, config.compat) }
			: { ...model, baseUrl };
	});
	for (const definition of config.models ?? []) {
		const existingIndex = models.findIndex((model) => isModelType(model, "chat") && model.id === definition.id);
		const defaults = findModelDefaults(models, definition.id, definition.api ?? config.api);
		const model = modelFromJson(providerId, definition, config, defaults);
		if (existingIndex >= 0) models[existingIndex] = model;
		else models.push(model);
	}
	return models;
}

function applyExtension(
	providerId: string,
	models: readonly AnyModel[],
	config: ProviderConfigInput | undefined,
): AnyModel[] {
	if (!config) return [...models];
	if (!config.models) {
		return config.baseUrl ? models.map((model) => ({ ...model, baseUrl: config.baseUrl! })) : [...models];
	}
	return config.models.map((definition) => extensionModelFromDefinition(providerId, models, config, definition));
}

function adaptOAuth(config: ExtensionOAuthConfig): OAuthAuth {
	return {
		name: config.name,
		isSubscription: config.isSubscription,
		login: async (callbacks) => {
			const credential = await config.login({
				onAuth: (info) => callbacks.notify({ type: "auth_url", ...info }),
				onDeviceCode: (info) => callbacks.notify({ type: "device_code", ...info }),
				onPrompt: (prompt) => callbacks.prompt({ type: "text", ...prompt }),
				onProgress: (message) => callbacks.notify({ type: "progress", message }),
				onManualCodeInput: () => callbacks.prompt({ type: "manual_code", message: "Paste the authorization code" }),
				onSelect: (prompt) => callbacks.prompt({ type: "select", ...prompt }),
				signal: callbacks.signal,
			});
			return { ...credential, type: "oauth" };
		},
		refresh: async (credential, signal) => ({ ...(await config.refreshToken(credential, signal)), type: "oauth" }),
		toAuth: async (credential) => ({ apiKey: config.getApiKey(credential) }),
	};
}

function withConfiguredAuth(
	auth: ModelAuth,
	headers: Record<string, string> | undefined,
	authHeader: boolean,
): ModelAuth {
	let mergedHeaders: ProviderHeaders | undefined =
		auth.headers || headers ? { ...auth.headers, ...headers } : undefined;
	if (authHeader) {
		if (!auth.apiKey) throw new Error("authHeader requires a resolved API key");
		mergedHeaders = { ...mergedHeaders, Authorization: `Bearer ${auth.apiKey}` };
	}
	return { ...auth, headers: mergedHeaders };
}

function configuredApiKey(
	config: ModelsJsonProvider | undefined,
	extension: ProviderConfigInput | undefined,
): string | undefined {
	return extension?.apiKey ?? config?.apiKey;
}

function configuredHeaders(
	config: ModelsJsonProvider | undefined,
	extension: ProviderConfigInput | undefined,
): Record<string, string> | undefined {
	if (!config?.headers && !extension?.headers) return undefined;
	return { ...config?.headers, ...extension?.headers };
}

async function configContextEnv(
	values: readonly string[],
	ctx: AuthContext,
	explicit?: Record<string, string>,
): Promise<Record<string, string> | undefined> {
	const env = { ...explicit };
	for (const name of new Set(values.flatMap(getConfigValueEnvVarNames))) {
		if (env[name] !== undefined) continue;
		const value = await ctx.env(name);
		if (value !== undefined) env[name] = value;
	}
	return Object.keys(env).length > 0 ? env : undefined;
}

function composeApiKeyAuth(
	providerId: string,
	base: Provider | undefined,
	config: ModelsJsonProvider | undefined,
	extension: ProviderConfigInput | undefined,
): ApiKeyAuth | undefined {
	const inherited = base?.auth.apiKey;
	const rawKey = configuredApiKey(config, extension);
	const oauth = extension?.oauth ?? base?.auth.oauth;
	// OAuth-only providers get no fabricated API-key login method.
	if (!inherited && rawKey === undefined && oauth) return undefined;
	const rawHeaders = configuredHeaders(config, extension);
	const authHeader = extension?.authHeader ?? config?.authHeader ?? false;
	return {
		name: inherited?.name ?? "API key",
		// An inherited auth without a login (e.g. ACP command auth) stays
		// login-free; only key-based setups get the API-key prompt fallback.
		login:
			inherited?.login ??
			(inherited
				? undefined
				: async (interaction: AuthInteraction) => ({
						type: "api_key",
						key: await interaction.prompt({ type: "secret", message: "Enter API key" }),
					})),
		check: async (input) => {
			if (input.credential) {
				if (inherited?.check) return inherited.check(input);
				if (input.credential.key) return { type: "api_key", source: "stored credential" };
				const resolved = await inherited?.resolve(input);
				return resolved ? { type: "api_key", source: resolved.source } : undefined;
			}
			if (rawKey !== undefined) {
				if (isCommandConfigValue(rawKey)) return { type: "api_key", source: "configured API key" };
				const envNames = getConfigValueEnvVarNames(rawKey);
				for (const name of envNames) {
					if ((await input.ctx.env(name)) === undefined) return undefined;
				}
				return { type: "api_key", source: "configured API key" };
			}
			if (inherited?.check) return inherited.check(input);
			const resolved = await inherited?.resolve(input);
			return resolved ? { type: "api_key", source: resolved.source } : undefined;
		},
		resolve: async (input) => {
			let result: AuthResult | undefined;
			if (input.credential) {
				result = inherited
					? await inherited.resolve(input)
					: input.credential.key
						? { auth: { apiKey: input.credential.key }, env: input.credential.env, source: "stored credential" }
						: undefined;
			} else if (rawKey !== undefined) {
				const env = await configContextEnv([rawKey], input.ctx);
				const key = resolveConfigValueOrThrow(rawKey, `API key for provider "${providerId}"`, env);
				result = inherited
					? await inherited.resolve({ ...input, credential: { type: "api_key", key } })
					: { auth: { apiKey: key }, source: "configured API key" };
			} else {
				result = await inherited?.resolve(input);
			}
			if (!result) return undefined;
			const explicitEnv = { ...(input.credential?.env ?? {}), ...(result.env ?? {}) };
			const headerEnv = await configContextEnv(Object.values(rawHeaders ?? {}), input.ctx, explicitEnv);
			const headers = resolveHeadersOrThrow(rawHeaders, `provider "${providerId}"`, headerEnv);
			return { ...result, auth: withConfiguredAuth(result.auth, headers, authHeader) };
		},
	};
}

function composeOAuthAuth(
	providerId: string,
	base: Provider | undefined,
	config: ModelsJsonProvider | undefined,
	extension: ProviderConfigInput | undefined,
): OAuthAuth | undefined {
	const oauth = extension?.oauth ? adaptOAuth(extension.oauth) : base?.auth.oauth;
	if (!oauth) return undefined;
	const rawHeaders = configuredHeaders(config, extension);
	const authHeader = extension?.authHeader ?? config?.authHeader ?? false;
	return {
		...oauth,
		toAuth: async (credential) => {
			const auth = await oauth.toAuth(credential);
			const env = credential.env;
			const headers = resolveHeadersOrThrow(
				rawHeaders,
				`provider "${providerId}"`,
				typeof env === "object" && env !== null ? (env as Record<string, string>) : undefined,
			);
			return withConfiguredAuth(auth, headers, authHeader);
		},
	};
}

function rawModelHeaders(
	model: AnyModel,
	config: ModelsJsonProvider | undefined,
	extension: ProviderConfigInput | undefined,
): Record<string, string> | undefined {
	// models.json definitions and overrides are chat-only. Extension definitions
	// are matched by operation and id so colliding models cannot share headers.
	const chatDefinition = isModelType(model, "chat")
		? config?.models?.find((entry) => entry.id === model.id)
		: undefined;
	const extensionModel = extension?.models?.find(
		(entry) => (entry.type ?? "chat") === (model.type ?? "chat") && entry.id === model.id,
	);
	const headers = {
		...(isModelType(model, "chat") ? config?.modelOverrides?.[model.id]?.headers : undefined),
		...chatDefinition?.headers,
		...extensionModel?.headers,
	};
	return Object.keys(headers).length > 0 ? headers : undefined;
}

/** ACP command explicitly configured in models.json, ignoring inherited models. */
function acpConfiguredCommand(config: ModelsJsonProvider | undefined): string | undefined {
	if (config?.command) return config.command;
	for (const definition of config?.models ?? []) {
		if (definition.command) return definition.command;
	}
	for (const override of Object.values(config?.modelOverrides ?? {})) {
		if (override.command) return override.command;
	}
	return undefined;
}

/** First ACP command visible for a provider: provider-level, model-level, overrides, then base models. */
function acpProviderCommand(base: Provider | undefined, config: ModelsJsonProvider | undefined): string | undefined {
	if (config?.command) return config.command;
	for (const definition of config?.models ?? []) {
		if (definition.command) return definition.command;
	}
	// modelOverrides replace a model's transport, so an override command wins over
	// the base model's command.
	for (const model of getAllProviderModels(base)) {
		if (model.api !== "acp") continue;
		const override = config?.modelOverrides?.[model.id];
		if (override?.command) return override.command;
		if (model.acp?.command) return model.acp.command;
	}
	return undefined;
}

/** Transport env configured for a provider: provider level, then any model entry. */
function acpProviderEnv(config: ModelsJsonProvider | undefined): Record<string, string> | undefined {
	if (config?.env) return config.env;
	for (const definition of config?.models ?? []) {
		if (definition.env) return definition.env;
	}
	return undefined;
}

/** Whether a provider serves ACP models from any layer. */
function usesAcpTransport(base: Provider | undefined, config: ModelsJsonProvider | undefined): boolean {
	if (config?.command || (config?.models ?? []).some((definition) => (definition.api ?? config?.api) === "acp")) {
		return true;
	}
	return getAllProviderModels(base).some((model) => model.api === "acp");
}

export function validateExtensionProvider(
	providerId: string,
	base: Provider | undefined,
	modelsConfig: ModelsJsonProvider | undefined,
	extension: ProviderConfigInput,
): void {
	if (extension.streamSimple && !extension.api) {
		throw new Error(`Provider ${providerId}: "api" is required when registering streamSimple.`);
	}
	applyExtension(providerId, applyModelsJson(providerId, getAllProviderModels(base), modelsConfig), extension);
}

/** Compose built-in, models.json, and extension layers without reading credentials. */
/** Case-insensitive substring filter over model ids. Include narrows first, exclude removes after. */
function acpModelFilter(config: ModelsJsonProvider | undefined): ((id: string) => boolean) | undefined {
	const include = config?.include?.filter((pattern) => pattern.length > 0);
	const exclude = config?.exclude?.filter((pattern) => pattern.length > 0);
	if (!include?.length && !exclude?.length) return undefined;
	return (id: string) => {
		const lower = id.toLowerCase();
		if (include?.length && !include.some((pattern) => lower.includes(pattern.toLowerCase()))) return false;
		if (exclude?.some((pattern) => lower.includes(pattern.toLowerCase()))) return false;
		return true;
	};
}

export function composeModelProvider(
	providerId: string,
	base: Provider | undefined,
	modelConfig: ModelConfig,
	extension: ProviderConfigInput | undefined,
): Provider {
	const config = modelConfig.getProvider(providerId);
	// Model-level commands count too: a Radius-oauth provider must not be able to
	// route some of its models through an ACP subprocess.
	const hasCommand = config?.command !== undefined || config?.models?.some((model) => model.command !== undefined);
	if (hasCommand && config?.oauth) {
		throw new Error(`Provider ${providerId}: "command" (ACP) cannot be combined with "oauth".`);
	}
	let extensionOAuthCredential: OAuthCredentials | undefined;
	let refreshedExtensionModels: ProviderConfigInput["models"];
	const currentExtension = (): ProviderConfigInput | undefined =>
		extension && refreshedExtensionModels ? { ...extension, models: refreshedExtensionModels } : extension;
	// models.json modelOverrides are the topmost user-config layer: they apply once,
	// after custom-model upserts, extension model replacement, and legacy OAuth projection.
	const getAllModels = (): AnyModel[] => {
		let models = applyExtension(
			providerId,
			applyModelsJson(providerId, getAllProviderModels(base), config),
			currentExtension(),
		);
		if (extensionOAuthCredential && extension?.oauth?.modifyModels) {
			// The extension hook is chat-only; other model types pass through untouched.
			models = [
				...extension.oauth.modifyModels(
					models.filter((model) => isModelType(model, "chat")),
					extensionOAuthCredential,
				),
				...models.filter((model) => !isModelType(model, "chat")),
			];
		}
		return models.map((model) => {
			const override = config?.modelOverrides?.[model.id];
			return override && isModelType(model, "chat") ? applyModelOverride(model, override) : model;
		});
	};
	// Validate eagerly so registration/reload reports structural errors immediately.
	getAllModels();
	const displayName = extension?.name ?? config?.name ?? base?.name ?? extension?.oauth?.name ?? providerId;
	let apiKey: ApiKeyAuth | undefined;
	// A models.json command replaces the builtin's, so it must also replace the
	// inherited command auth — otherwise the old command gates availability.
	const configuredCommand = acpConfiguredCommand(config);
	const baseCommand = getAllProviderModels(base).find((model) => model.api === "acp")?.acp?.command;
	const overridesBaseCommand = configuredCommand !== undefined && configuredCommand !== baseCommand;
	if (
		usesAcpTransport(base, config) &&
		configuredApiKey(config, extension) === undefined &&
		(overridesBaseCommand || !base?.auth.apiKey)
	) {
		const command = acpProviderCommand(base, config);
		if (command) {
			apiKey = acpCommandAuth(
				displayName,
				() => acpProviderCommand(base, config),
				() => acpProviderEnv(config),
			);
		}
	}
	apiKey ??= composeApiKeyAuth(providerId, base, config, extension);
	const oauth = composeOAuthAuth(providerId, base, config, extension);
	if (!apiKey && !oauth) throw new Error(`Provider ${providerId}: no authentication method configured.`);

	const supportsBaseApi = (model: Model<Api>) => base?.getModels().some((entry) => entry.api === model.api) ?? false;
	const streamWith = (
		model: Model<Api>,
		context: TranscriptContext,
		options: StreamOptions | undefined,
		simple: boolean,
	): AssistantMessageEventStream =>
		lazyStream(model, async () => {
			if (extension?.streamSimple && model.api === extension.api) {
				return extension.streamSimple(model, context, options as SimpleStreamOptions);
			}
			if (base && supportsBaseApi(model)) {
				return simple
					? base.streamSimple(model, context, options as SimpleStreamOptions)
					: base.stream(model, context, options);
			}
			const api = getApiProvider(model.api);
			if (!api) throw new Error(`No API provider registered for api: ${model.api}`);
			return simple
				? api.streamSimple(model, context, options as SimpleStreamOptions)
				: api.stream(model, context, options);
		});

	const provider: Provider = {
		id: providerId,
		name: displayName,
		baseUrl: extension?.baseUrl ?? config?.baseUrl ?? base?.baseUrl,
		headers: base?.headers,
		auth: { ...(apiKey ? { apiKey } : {}), ...(oauth ? { oauth } : {}) },
		getModels: () => getAllModels().filter((model) => isModelType(model, "chat")),
		getAllModels,
		refreshModels:
			base?.refreshModels || extension?.refreshModels || extension?.oauth?.modifyModels
				? async (context) => {
						await base?.refreshModels?.(context);
						let refreshed: NonNullable<ProviderConfigInput["models"]> | undefined;
						if (extension?.refreshModels) refreshed = await extension.refreshModels(context);
						if (context.signal.aborted) return;
						const oauthCredential = context.credential?.type === "oauth" ? context.credential : undefined;
						await context.publish({
							update: () => {
								if (refreshed) {
									// Validate before publishing the new synchronous list.
									applyExtension(providerId, applyModelsJson(providerId, getAllProviderModels(base), config), {
										...extension,
										models: refreshed,
									});
									refreshedExtensionModels = refreshed;
								}
								extensionOAuthCredential = oauthCredential;
							},
						});
					}
				: undefined,
		filterModels: base?.filterModels
			? (models, credential: Credential | undefined) => base.filterModels!(models, credential)
			: undefined,
		filterAllModels: base?.filterAllModels
			? (models, credential: Credential | undefined) => base.filterAllModels!(models, credential)
			: undefined,
		stream: (model, context, options) => streamWith(model, context, options, false),
		streamSimple: (model, context, options) => streamWith(model, context, options, true),
	};

	const filter = acpModelFilter(config);
	if (filter) {
		if (!usesAcpTransport(base, config)) {
			throw new Error(`Provider ${providerId}: "include"/"exclude" require an ACP provider.`);
		}
		// View-layer filter: the persisted snapshot stays complete, reads are narrowed.
		const unfilteredAll = provider.getAllModels?.bind(provider) ?? (() => getAllModels());
		const unfilteredChat = provider.getModels.bind(provider);
		provider.getAllModels = () => unfilteredAll().filter((model) => filter(model.id));
		provider.getModels = () => unfilteredChat().filter((model) => filter(model.id));
	}

	const fetchDeferred = base?.fetchDeferred;
	if (fetchDeferred) {
		provider.fetchDeferred = (model, handle, options) => fetchDeferred(model, handle, options);
	}
	const cancelDeferred = base?.cancelDeferred;
	if (cancelDeferred) {
		provider.cancelDeferred = (model, handle, options) => cancelDeferred(model, handle, options);
	}
	const extensionImages = extension?.images;
	const generateImages = base?.generateImages;
	if (generateImages || Object.keys(extensionImages ?? {}).length > 0) {
		provider.generateImages = (model, context, options) => {
			const implementation = extensionImages?.[model.api];
			if (implementation) return implementation.generateImages(model, context, options);
			if (generateImages) return generateImages(model, context, options);
			return Promise.resolve(
				imageErrorResult(model, new Error(`Provider ${providerId} has no image implementation for "${model.api}"`)),
			);
		};
	}
	const extensionClassifiers = extension?.classifiers;
	const classify = base?.classify;
	if (classify || Object.keys(extensionClassifiers ?? {}).length > 0) {
		provider.classify = (model, context, options) => {
			const implementation = extensionClassifiers?.[model.api];
			if (implementation) return implementation.classify(model, context, options);
			if (classify) return classify(model, context, options);
			return Promise.resolve(
				classifierErrorResult(
					model,
					new Error(`Provider ${providerId} has no classifier implementation for "${model.api}"`),
				),
			);
		};
	}

	return provider;
}

export function resolveConfiguredModelHeaders(
	model: AnyModel,
	config: ModelsJsonProvider | undefined,
	extension: ProviderConfigInput | undefined,
	env?: Record<string, string>,
): Record<string, string> | undefined {
	return resolveHeadersOrThrow(
		rawModelHeaders(model, config, extension),
		`model "${model.provider}/${model.id}"`,
		env,
	);
}

export interface CompatibilityRequestConfig {
	headers?: ProviderHeaders;
	authHeader: boolean;
}

export function resolveCompatibilityRequestConfig(
	model: AnyModel,
	config: ModelsJsonProvider | undefined,
	extension: ProviderConfigInput | undefined,
): CompatibilityRequestConfig {
	const configured = resolveHeadersOrThrow(
		{ ...configuredHeaders(config, extension), ...rawModelHeaders(model, config, extension) },
		`model "${model.provider}/${model.id}"`,
	);
	return {
		headers: model.headers || configured ? { ...model.headers, ...configured } : undefined,
		authHeader: extension?.authHeader ?? config?.authHeader ?? false,
	};
}

export function configuredRequestAuthStatus(
	config: ModelsJsonProvider | undefined,
	extension: ProviderConfigInput | undefined,
): AuthStatus | undefined {
	const value = configuredApiKey(config, extension);
	if (value === undefined) return undefined;
	if (isCommandConfigValue(value)) return { configured: true, source: "models_json_command" };
	const names = getConfigValueEnvVarNames(value);
	if (names.length > 0) {
		return isConfigValueConfigured(value)
			? { configured: true, source: "environment", label: names.join(", ") }
			: { configured: false };
	}
	return { configured: true, source: extension?.apiKey !== undefined ? "fallback" : "models_json_key" };
}
