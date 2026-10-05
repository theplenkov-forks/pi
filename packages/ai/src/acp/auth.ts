/**
 * Authentication for ACP subprocess providers.
 *
 * There is no token to resolve: the agent binary owns its credentials
 * (`devin auth login`, `WINDSURF_API_KEY`, host-managed auth, ...). A provider
 * counts as configured when its command resolves to an executable. This is a
 * Node-only module; providers reach it through a bundler-opaque dynamic
 * import so browser builds never follow it (see `../api.lazy.ts` pattern).
 */

import { accessSync, constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import type { ApiKeyAuth, AuthCheck, AuthContext, AuthResult } from "../auth/types.ts";

/** Locate a binary on PATH. Returns the absolute path or undefined. */
export function findAcpCommand(command: string, pathValue?: string): string | undefined {
	const trimmed = command.trim();
	if (!trimmed) return undefined;
	const firstSpace = trimmed.search(/\s/);
	const binary = firstSpace < 0 ? trimmed : trimmed.slice(0, firstSpace);
	if (isAbsolute(binary)) return isExecutable(binary) ? binary : undefined;
	const path = pathValue ?? process.env.PATH ?? "";
	const extensions = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
	for (const dir of path.split(delimiter)) {
		if (!dir) continue;
		for (const extension of extensions) {
			const candidate = join(dir, `${binary}${extension}`);
			if (isExecutable(candidate)) return candidate;
		}
	}
	return undefined;
}

function isExecutable(path: string): boolean {
	try {
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/** Split `argv[0]` for display without resolving. */
export function acpCommandName(command: string): string {
	const trimmed = command.trim();
	const space = trimmed.search(/\s/);
	const binary = space < 0 ? trimmed : trimmed.slice(0, space);
	const base = binary.split("/").pop() ?? binary;
	return base.split("\\").pop() ?? base;
}

function resolveBinary(
	command: string | undefined,
	pathValue?: string,
): { command: string; binary: string } | undefined {
	const trimmed = command?.trim();
	if (!trimmed) return undefined;
	const firstSpace = trimmed.search(/\s/);
	const binary = firstSpace < 0 ? trimmed : trimmed.slice(0, firstSpace);
	let resolved: string | undefined;
	if (isAbsolute(binary)) {
		resolved = isExecutable(binary) ? binary : undefined;
	} else if (binary.includes("/") || binary.includes("\\")) {
		const candidate = join(process.cwd(), binary);
		resolved = isExecutable(candidate) ? candidate : undefined;
	} else {
		resolved = findAcpCommand(binary, pathValue);
	}
	return resolved ? { command: trimmed, binary: resolved } : undefined;
}

export async function checkAcpCommand(
	command: string | undefined,
	input: { ctx: AuthContext; credential?: { env?: Record<string, string> }; signal: AbortSignal },
): Promise<AuthCheck | undefined> {
	input.signal.throwIfAborted();
	const resolved = resolveBinary(command, input.credential?.env?.PATH);
	if (!resolved) return undefined;
	return { type: "api_key", source: `ACP command "${acpCommandName(resolved.binary)}"` };
}

export async function resolveAcpCommand(
	command: string | undefined,
	input: {
		ctx: AuthContext;
		credential?: { env?: Record<string, string> };
		signal: AbortSignal;
	},
): Promise<AuthResult | undefined> {
	input.signal.throwIfAborted();
	const resolved = resolveBinary(command, input.credential?.env?.PATH);
	if (!resolved) return undefined;
	return {
		auth: {},
		env: input.credential?.env,
		source: `ACP command "${acpCommandName(resolved.binary)}"`,
	};
}

/** ApiKeyAuth shape for ACP commands (Node runtime; loaded lazily by providers). */
export function acpCommandAuth(name: string, getCommand: () => string | undefined): ApiKeyAuth {
	return {
		name,
		check: (input) => checkAcpCommand(getCommand(), input),
		resolve: (input) => resolveAcpCommand(getCommand(), input),
	};
}
