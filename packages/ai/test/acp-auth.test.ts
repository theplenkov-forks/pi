import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acpCommandAuth, acpCommandName, findAcpCommand } from "../src/acp/auth.ts";

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
		makeExecutable(dir, "my-agent");
		expect(findAcpCommand("my-agent", dir)).toContain("my-agent");
		expect(findAcpCommand("no-such-agent", dir)).toBeUndefined();
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
		const auth = acpCommandAuth("Devin", () => "no-such-acp-binary-xyz");
		expect(await auth.check?.({ ...testContext(), credential: undefined })).toBeUndefined();
		expect(await auth.resolve?.({ ...testContext(), credential: undefined })).toBeUndefined();
		expect(auth.login).toBeUndefined();
	});
});
