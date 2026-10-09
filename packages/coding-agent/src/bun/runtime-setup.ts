import { setAcpDiscoveryModule } from "@earendil-works/pi-ai/acp/api.lazy";
import { acpApiModule, acpDiscoveryFn } from "@earendil-works/pi-ai/acp/api-node";
import * as acpAuthModule from "@earendil-works/pi-ai/acp/auth";
import { setAcpAuthModule } from "@earendil-works/pi-ai/acp/provider";
import { bedrockProviderModule } from "@earendil-works/pi-ai/bedrock-provider";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { setAcpApiModule, setBedrockProviderModule } from "@earendil-works/pi-ai/compat";
// Bun loads .wasm imports as files: embedded in compiled executables, evaluating to a readable path.
import quickjsWasmPath from "quickjs-wasi/quickjs.wasm";
import { APP_NAME, setEmbeddedQuickJSWasmPath } from "../config.ts";

process.title = APP_NAME;
process.emitWarning = (() => {}) as typeof process.emitWarning;
registerBunOAuthFlows();
setAcpApiModule(acpApiModule);
setAcpAuthModule(acpAuthModule);
setAcpDiscoveryModule(acpDiscoveryFn);
setBedrockProviderModule(bedrockProviderModule);
setEmbeddedQuickJSWasmPath(quickjsWasmPath);
