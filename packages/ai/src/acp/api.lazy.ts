import { lazyApi } from "../api/lazy.ts";
import type { ProviderEnv, ProviderStreams } from "../types.ts";
import type { AcpSessionInfo } from "./pool.ts";
import type { AcpTransportConfig } from "./types.ts";

export interface AcpDiscoveryOptions {
	signal?: AbortSignal;
	env?: ProviderEnv;
	cwd?: string;
}

export type AcpDiscoveryFn = (transport: AcpTransportConfig, options?: AcpDiscoveryOptions) => Promise<AcpSessionInfo>;

/**
 * Loads the ACP implementation through a variable specifier so bundlers
 * (browser smoke, Bun compile) cannot follow the import into the Node-only
 * subprocess code. The `.ts`/`.js` rewrite keeps the trick working from both
 * source and built output.
 */
const importNodeOnlyApi = (specifier: string): Promise<unknown> => {
	const runtimeSpecifier = import.meta.url.endsWith(".js") ? specifier.replace(/\.ts$/, ".js") : specifier;
	return import(runtimeSpecifier);
};

let acpModuleOverride: ProviderStreams | undefined;

/**
 * Overrides the dynamically imported ACP implementation. Used by the Bun
 * binary build, where the variable-specifier import cannot be bundled; the
 * build registers a statically imported module instead.
 */
export function setAcpApiModule(module: ProviderStreams): void {
	acpModuleOverride = module;
}

export const acpApi = (): ProviderStreams =>
	lazyApi(async () => acpModuleOverride ?? ((await importNodeOnlyApi("./api.ts")) as ProviderStreams));

let acpDiscoveryOverride: AcpDiscoveryFn | undefined;

/** Overrides the dynamically imported ACP discovery (Bun binary build). */
export function setAcpDiscoveryModule(fn: AcpDiscoveryFn): void {
	acpDiscoveryOverride = fn;
}

/** Read an agent's session config (models, modes) without disturbing live sessions. */
export async function fetchAcpSessionInfo(
	transport: AcpTransportConfig,
	options?: AcpDiscoveryOptions,
): Promise<AcpSessionInfo> {
	if (acpDiscoveryOverride) return acpDiscoveryOverride(transport, options);
	const module = (await importNodeOnlyApi("./pool.ts")) as {
		fetchAcpSessionInfo: AcpDiscoveryFn;
	};
	return module.fetchAcpSessionInfo(transport, options);
}
