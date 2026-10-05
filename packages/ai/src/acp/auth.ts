/**
 * Authentication for ACP subprocess providers.
 *
 * There is no token to resolve: the agent binary owns its credentials
 * (`devin auth login`, `WINDSURF_API_KEY`, host-managed auth, ...). A provider
 * counts as configured when its command resolves to an executable. This is a
 * Node-only module; providers reach it through a bundler-opaque dynamic
 * import so browser builds never follow it (see `../api.lazy.ts` pattern).
 */

import { accessSync, constants, statSync } from "node:fs";
import { delimiter, extname, isAbsolute, join } from "node:path";
import type { ApiKeyAuth, AuthCheck, AuthContext, AuthResult } from "../auth/types.ts";

/** `command` is an executable, not a command line: keep the whole trimmed value. */
function binaryName(command: string): string {
	return command.trim();
}

/**
 * Suffixes to try for a bare command name. An empty first entry tries the name
 * exactly as configured (`agent.cmd`, extensionless scripts), then the OS
 * default PATHEXT so lookup never rejects a command the OS would run.
 */
function candidateSuffixes(binary: string): string[] {
	if (process.platform !== "win32") return [""];
	if (extname(binary)) return [""];
	return ["", ...(process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)];
}

/** Locate a binary on PATH. Returns the absolute path or undefined. */
export function findAcpCommand(command: string, pathValue?: string): string | undefined {
	const binary = binaryName(command);
	if (!binary) return undefined;
	if (isAbsolute(binary)) return isExecutable(binary) ? binary : undefined;
	const path = pathValue ?? process.env.PATH ?? "";
	const suffixes = candidateSuffixes(binary);
	for (const dir of path.split(delimiter)) {
		// An empty PATH entry means the current directory, as in POSIX shells.
		const base = dir || ".";
		for (const suffix of suffixes) {
			const candidate = join(base, `${binary}${suffix}`);
			if (isExecutable(candidate)) return candidate;
		}
	}
	return undefined;
}

/** Executable and a regular file: a directory named like the agent is not one. */
function isExecutable(path: string): boolean {
	try {
		if (!statSync(path).isFile()) return false;
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/** Base name of a command, for display. */
export function acpCommandName(command: string): string {
	const binary = binaryName(command);
	const base = binary.split("/").pop() ?? binary;
	return base.split("\\").pop() ?? base;
}

/**
 * Resolve a configured command the way the OS will: absolute paths, paths
 * relative to the working directory (`./tools/agent`), then PATH lookup. Shared
 * by auth checks and the spawn path so a provider that resolves as configured
 * can actually be started.
 */
export function resolveAcpBinary(command: string | undefined, pathValue?: string): string | undefined {
	const binary = binaryName(command ?? "");
	if (!binary) return undefined;
	if (isAbsolute(binary)) return isExecutable(binary) ? binary : undefined;
	if (binary.includes("/") || binary.includes("\\")) {
		const candidate = join(process.cwd(), binary);
		return isExecutable(candidate) ? candidate : undefined;
	}
	return findAcpCommand(binary, pathValue);
}

export async function checkAcpCommand(
	command: string | undefined,
	input: { ctx: AuthContext; credential?: { env?: Record<string, string> }; signal: AbortSignal },
	transportEnv?: Record<string, string>,
): Promise<AuthCheck | undefined> {
	input.signal.throwIfAborted();
	const resolved = resolveAcpBinary(command, effectivePath(transportEnv, input.credential?.env));
	if (!resolved) return undefined;
	return { type: "api_key", source: `ACP command "${acpCommandName(resolved)}"` };
}

export async function resolveAcpCommand(
	command: string | undefined,
	input: {
		ctx: AuthContext;
		credential?: { env?: Record<string, string> };
		signal: AbortSignal;
	},
	transportEnv?: Record<string, string>,
): Promise<AuthResult | undefined> {
	input.signal.throwIfAborted();
	const resolved = resolveAcpBinary(command, effectivePath(transportEnv, input.credential?.env));
	if (!resolved) return undefined;
	return {
		auth: {},
		env: { ...transportEnv, ...input.credential?.env },
		source: `ACP command "${acpCommandName(resolved)}"`,
	};
}

/**
 * PATH the spawned agent will actually see. Configured transport `env.PATH`
 * wins over the ambient process PATH, and a resolved credential overrides both.
 */
function effectivePath(
	transportEnv: Record<string, string> | undefined,
	credentialEnv: Record<string, string> | undefined,
): string | undefined {
	return typeof credentialEnv?.PATH === "string"
		? credentialEnv.PATH
		: typeof transportEnv?.PATH === "string"
			? transportEnv.PATH
			: undefined;
}

/**
 * ApiKeyAuth shape for ACP commands (Node runtime; loaded lazily by providers).
 * `getEnv` supplies the configured transport env so a command reachable only
 * through it still counts as configured.
 */
export function acpCommandAuth(
	name: string,
	getCommand: () => string | undefined,
	getEnv?: () => Record<string, string> | undefined,
): ApiKeyAuth {
	return {
		name,
		check: (input) => checkAcpCommand(getCommand(), input, getEnv?.()),
		resolve: (input) => resolveAcpCommand(getCommand(), input, getEnv?.()),
	};
}
