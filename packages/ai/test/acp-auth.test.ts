import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acpCommandAuth, acpCommandName, findAcpCommand, resolveAcpBinary } from "../src/acp/auth.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// Best-effort cleanup.
		}
	}
});

function makeExecutable(dir: string, name: string): string {
	const path = join(dir, name);
	writeFileSync(path, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
	return path;
}

function testContext() {
	return {
		ctx: { env: async () => undefined, fileExists: async () => false },
		signal: new AbortController().signal,
	};
}

describe("findAcpCommand", () => {
	it("resolves absolute paths", () => {
		const dir = mkdtempSync(join(tmpdir(), "acp-auth-"));
		tempDirs.push(dir);
		const binary = makeExecutable(dir, "devin");
		expect(findAcpCommand(binary)).toBe(binary);
		expect(findAcpCommand(join(dir, "missing"))).toBeUndefined();
		expect(findAcpCommand("")).toBeUndefined();
	});

	it("resolves bare names on PATH", () => {
		const dir = mkdtempSync(join(tmpdir(), "acp-auth-"));
		tempDirs.push(dir);
		// On Windows only PATHEXT-suffixed names resolve, so name the fixture accordingly.
		makeExecutable(dir, process.platform === "win32" ? "my-agent.cmd" : "my-agent");
		expect(findAcpCommand("my-agent", dir)).toContain("my-agent");
		expect(findAcpCommand("no-such-agent", dir)).toBeUndefined();
	});

	it("ignores directories that share the command name", () => {
		const dir = mkdtempSync(join(tmpdir(), "acp-auth-"));
		tempDirs.push(dir);
		mkdirSync(join(dir, "fake-agent"));
		expect(findAcpCommand("fake-agent", dir)).toBeUndefined();
	});

	it("resolves a command given as a working-directory-relative path", () => {
		const dir = mkdtempSync(join(tmpdir(), "acp-auth-"));
		tempDirs.push(dir);
		makeExecutable(dir, "local-agent");
		const previousCwd = process.cwd();
		try {
			process.chdir(dir);
			expect(resolveAcpBinary("./local-agent")).toContain("local-agent");
		} finally {
			process.chdir(previousCwd);
		}
	});
});

describe("resolveAcpBinary", () => {
	it("keeps spaces in the executable path", () => {
		const dir = mkdtempSync(join(tmpdir(), "acp-auth-"));
		tempDirs.push(dir);
		const spaced = join(dir, "My Agent");
		mkdirSync(spaced);
		const binary = makeExecutable(spaced, "acp");
		expect(resolveAcpBinary(binary)).toBe(binary);
	});
});

describe("acpCommandName", () => {
	it("returns the binary basename", () => {
		expect(acpCommandName("/usr/local/bin/devin")).toBe("devin");
		expect(acpCommandName("devin")).toBe("devin");
	});
});

describe("acpCommandAuth", () => {
	it("reports configured when the command resolves, with no login flow", async () => {
		const dir = mkdtempSync(join(tmpdir(), "acp-auth-"));
		tempDirs.push(dir);
		const binary = makeExecutable(dir, "devin");
		const auth = acpCommandAuth("Devin", () => binary);
		expect(await auth.check?.({ ...testContext(), credential: undefined })).toEqual({
			type: "api_key",
			source: 'ACP command "devin"',
		});
		const resolved = await auth.resolve?.({ ...testContext(), credential: undefined });
		expect(resolved?.auth).toEqual({});
		expect(resolved?.source).toContain("devin");
		expect(auth.login).toBeUndefined();
	});

	it("reports unconfigured when the command is missing", async () => {
		// An empty PATH makes the result independent of the ambient environment.
		const auth = acpCommandAuth(
			"Devin",
			() => "no-such-acp-binary-xyz",
			() => ({ PATH: "" }),
		);
		expect(await auth.check?.({ ...testContext(), credential: undefined })).toBeUndefined();
		expect(await auth.resolve?.({ ...testContext(), credential: undefined })).toBeUndefined();
		expect(auth.login).toBeUndefined();
	});

	it("finds a command reachable only through the configured transport env", async () => {
		const dir = mkdtempSync(join(tmpdir(), "acp-auth-"));
		tempDirs.push(dir);
		makeExecutable(dir, "env-agent");
		const auth = acpCommandAuth(
			"Agent",
			() => "env-agent",
			() => ({ PATH: dir }),
		);
		expect(await auth.check?.({ ...testContext(), credential: undefined })).toEqual({
			type: "api_key",
			source: 'ACP command "env-agent"',
		});
		// The configured env is handed to the request, not just used for lookup.
		expect((await auth.resolve?.({ ...testContext(), credential: undefined }))?.env).toEqual({ PATH: dir });
	});
});
