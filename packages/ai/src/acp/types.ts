/** Generic ACP (Agent Client Protocol) transport configuration. */

import type { ModelAcpTransport } from "../types.ts";

/** Wire API id used by ACP-backed chat models. */
export const ACP_API = "acp";

/** Synthetic base URL for ACP models, which have no HTTP endpoint. */
export function acpBaseUrl(providerId: string): string {
	return `acp://${providerId}`;
}

/** How to spawn an ACP agent subprocess (Zed-style `command` + `args` + `env`). */
export interface AcpTransportConfig {
	command: string;
	args?: string[];
	env?: Record<string, string>;
}

/** Merge model-level overrides over provider-level defaults. */
export function resolveAcpTransport(
	provider: ModelAcpTransport | undefined,
	model: ModelAcpTransport | undefined,
): AcpTransportConfig | undefined {
	const command = model?.command ?? provider?.command;
	if (!command) return undefined;
	const args = model?.args ?? provider?.args;
	const env = { ...provider?.env, ...model?.env };
	return { command, ...(args !== undefined ? { args } : {}), ...(Object.keys(env).length > 0 ? { env } : {}) };
}

/** Split a command line into argv for error messages. Never executes anything. */
export function formatAcpCommand(transport: AcpTransportConfig): string {
	return [transport.command, ...(transport.args ?? [])].join(" ");
}
