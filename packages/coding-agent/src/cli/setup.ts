import { setAcpApiModule, setAcpDiscoveryModule } from "@earendil-works/pi-ai/acp/api.lazy";
import { acpApiModule, acpDiscoveryFn } from "@earendil-works/pi-ai/acp/api-node";
import * as acpAuthModule from "@earendil-works/pi-ai/acp/auth";
import { setAcpAuthModule } from "@earendil-works/pi-ai/acp/provider";
import { APP_NAME } from "../config.ts";
import { configureHttpDispatcher } from "../core/http-dispatcher.ts";

/**
 * Runtime wiring every Node entrypoint needs (CLI, experimental CLI, rpc-entry).
 * ACP subprocess modules load through bundler-opaque dynamic imports (browser
 * smoke, Bun compile), so bundled Node builds must register the statically
 * imported implementations here instead.
 */
export function setupRuntime(): void {
	process.env.PI_CODING_AGENT = "true";
	process.env.AI_AGENT = "pi";
	process.emitWarning = (() => {}) as typeof process.emitWarning;

	setAcpApiModule(acpApiModule);
	setAcpAuthModule(acpAuthModule);
	setAcpDiscoveryModule(acpDiscoveryFn);

	// Configure undici before provider SDKs issue requests. Settings are applied
	// once SettingsManager has loaded global/project configuration.
	configureHttpDispatcher();
}

export function setupCli(): void {
	process.title = APP_NAME;
	setupRuntime();
}
