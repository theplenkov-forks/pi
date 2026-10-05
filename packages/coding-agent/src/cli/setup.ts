import { setAcpApiModule, setAcpDiscoveryModule } from "@earendil-works/pi-ai/acp/api.lazy";
import { acpApiModule, acpDiscoveryFn } from "@earendil-works/pi-ai/acp/api-node";
import * as acpAuthModule from "@earendil-works/pi-ai/acp/auth";
import { setAcpAuthModule } from "@earendil-works/pi-ai/acp/provider";
import { APP_NAME } from "../config.ts";
import { configureHttpDispatcher } from "../core/http-dispatcher.ts";

export function setupCli(): void {
	process.title = APP_NAME;
	process.env.PI_CODING_AGENT = "true";
	process.env.AI_AGENT = "pi";
	process.emitWarning = (() => {}) as typeof process.emitWarning;

	// ACP subprocess modules load through bundler-opaque dynamic imports
	// (browser smoke, Bun compile). Register the statically imported
	// implementations so bundled Node builds use them directly.
	setAcpApiModule(acpApiModule);
	setAcpAuthModule(acpAuthModule);
	setAcpDiscoveryModule(acpDiscoveryFn);

	// Configure undici before provider SDKs issue requests. Settings are applied
	// once SettingsManager has loaded global/project configuration.
	configureHttpDispatcher();
}
