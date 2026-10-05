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
	// Reject a blank command here rather than at spawn, where it would surface
	// as a misleading missing-executable error.
	const command = (model?.command ?? provider?.command)?.trim();
	if (!command) return undefined;
	const args = model?.args ?? provider?.args;
	const env = { ...provider?.env, ...model?.env };
	return { command, ...(args !== undefined ? { args } : {}), ...(Object.keys(env).length > 0 ? { env } : {}) };
}

/**
 * Join the command and its args into a display string, keeping flags but not
 * values: this text goes into error messages and logs, and args can carry
 * secrets. Never parses or executes.
 */
export function formatAcpCommand(transport: AcpTransportConfig): string {
	const args = (transport.args ?? []).map((arg) => (arg.startsWith("-") ? arg : "…"));
	return [transport.command, ...args].join(" ");
}
