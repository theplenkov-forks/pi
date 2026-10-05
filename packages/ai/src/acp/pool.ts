/**
 * Process pool for ACP agent subprocesses (Zed-style: one process per
 * configured `command` + `args`, one ACP session per pi session).
 *
 * Sessions are stateful: only transcript messages not yet sent are prompted,
 * so the agent keeps turn-to-turn context. A rewind (compaction, model
 * switch with a shorter transcript) starts a fresh ACP session.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type { Message, ProviderEnv } from "../types.ts";
import { acpCommandName, resolveAcpBinary } from "./auth.ts";
import { transcriptToAcpPrompt } from "./transcript.ts";
import { type AcpTransportConfig, formatAcpCommand } from "./types.ts";

export interface AcpRunOptions {
	/** Pi session id for ACP session affinity. Omit for an ephemeral session. */
	sessionKey?: string;
	cwd?: string;
	signal?: AbortSignal;
	env?: ProviderEnv;
	systemPrompt?: string;
	/** Model accepts image blocks. Defaults to true; omit images for text-only agents. */
	supportsImages?: boolean;
	/** Explicit prompt blocks (from `onPayload` replacement). Advances history like a normal turn. */
	blocks?: acp.ContentBlock[];
	onUpdate?: (notification: acp.SessionNotification) => void | Promise<void>;
}

export interface AcpTurnUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** Turn cost in dollars when the agent reported cumulative USD cost. */
	costTotal?: number;
}

export interface AcpPromptResult {
	stopReason: acp.StopReason;
	turnUsage: AcpTurnUsage;
}

interface ConsumedTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

interface PooledSession {
	session: acp.ActiveSession;
	/** Transcript messages already accepted by the agent. */
	sentCount: number;
	/**
	 * Identity of the last message counted in `sentCount`. A transcript branch
	 * or edit can keep the same length while changing history, so identity —
	 * not length — decides whether the ACP session still matches.
	 */
	lastSent?: Message;
	/** System prompt the session was created with. */
	systemPrompt?: string;
	consumed: ConsumedTotals;
}

interface PooledConnection {
	proc: ChildProcess;
	connection: acp.ClientConnection;
	sessions: Map<string, PooledSession>;
	activeTurns: number;
	/** Signal of the turn currently running on this connection, if any. */
	turnSignal?: AbortSignal;
}

const pool = new Map<string, PooledConnection>();
/** In-flight spawns per transport key, so concurrent first callers share one process. */
const connecting = new Map<string, Promise<PooledConnection>>();

function setHandlesReferenced(entry: PooledConnection, referenced: boolean): void {
	entry.proc[referenced ? "ref" : "unref"]();
	for (const stream of [entry.proc.stdin, entry.proc.stdout, entry.proc.stderr]) {
		if (!stream) continue;
		const handle = stream as unknown as { ref(): void; unref(): void };
		if (referenced) handle.ref();
		else handle.unref();
	}
}

/** Keep pooled subprocesses from retaining the event loop when no turn is running. */
function trackTurnStart(entry: PooledConnection): void {
	entry.activeTurns += 1;
	if (entry.activeTurns === 1) setHandlesReferenced(entry, true);
}

function trackTurnEnd(entry: PooledConnection): void {
	entry.activeTurns = Math.max(0, entry.activeTurns - 1);
	if (entry.activeTurns === 0) setHandlesReferenced(entry, false);
}

let exitHookRegistered = false;

/** Synchronous backstop so pooled agents never outlive the pi process. */
function ensureExitHook(): void {
	if (exitHookRegistered) return;
	exitHookRegistered = true;
	process.once("exit", () => {
		for (const entry of pool.values()) {
			try {
				entry.proc.kill();
			} catch {
				// Ignore teardown errors during process exit.
			}
		}
	});
}

function transportKey(transport: AcpTransportConfig, env?: ProviderEnv): string {
	return JSON.stringify({
		command: transport.command,
		args: transport.args ?? [],
		env: { ...transport.env, ...env },
	});
}

function throwIfAborted(signal?: AbortSignal): void {
	signal?.throwIfAborted();
}

async function readTextFileContent(path: string): Promise<string> {
	return readFile(resolve(path), "utf-8");
}

async function writeTextFileContent(path: string, content: string): Promise<void> {
	const resolved = resolve(path);
	await mkdir(dirname(resolved), { recursive: true });
	await writeFile(resolved, content, "utf-8");
}

async function establishTransport(
	key: string,
	transport: AcpTransportConfig,
	options: AcpRunOptions,
): Promise<PooledConnection> {
	/** Set once the entry exists, for handlers that need the live turn state. */
	let current: PooledConnection | undefined;
	const existing = pool.get(key);
	if (existing && !existing.connection.signal.aborted) return existing;
	if (existing) {
		pool.delete(key);
		existing.proc.kill();
	}

	const label = formatAcpCommand(transport);
	const searchPath =
		typeof options.env?.PATH === "string"
			? options.env.PATH
			: typeof transport.env?.PATH === "string"
				? transport.env.PATH
				: undefined;
	if (!resolveAcpBinary(transport.command, searchPath)) {
		throw new Error(
			`ACP agent "${label}" not found: no executable "${acpCommandName(transport.command)}" on PATH. Install it or fix the provider "command".`,
		);
	}
	const proc = spawn(transport.command, transport.args ?? [], {
		stdio: ["pipe", "pipe", "pipe"],
		env: { ...process.env, ...transport.env, ...options.env },
		cwd: options.cwd ?? process.cwd(),
		windowsHide: true,
	});
	// ACP agents log on stderr; drain it so a full pipe never blocks the agent.
	// Surface output only when debugging this integration.
	proc.stderr?.on("data", (chunk: Buffer) => {
		if (process.env.PI_ACP_LOG) process.stderr.write(`[acp:${label}] ${chunk}`);
	});
	const spawnError = await new Promise<Error | undefined>((resolveSpawn) => {
		proc.once("error", (error: Error) => resolveSpawn(error));
		proc.once("spawn", () => resolveSpawn(undefined));
	});
	if (spawnError) {
		proc.kill();
		throw new Error(`Failed to start ACP agent "${label}": ${spawnError.message}`);
	}
	if (!proc.stdin || !proc.stdout) {
		proc.kill();
		throw new Error(`Failed to start ACP agent "${label}": stdio unavailable`);
	}

	const app = acp
		.client({ name: "pi" })
		.onRequest(acp.methods.client.session.requestPermission, (ctx) => {
			// Consult the running turn's signal, not the one captured when the
			// process was spawned: an earlier turn's abort must not cancel
			// permission requests for later turns on the same connection.
			if (ctx.signal.aborted || current?.turnSignal?.aborted) return { outcome: { outcome: "cancelled" } };
			const choices = ctx.params.options;
			const pick =
				choices.find((option) => option.kind === "allow_once") ??
				choices.find((option) => option.kind === "allow_always") ??
				choices[0];
			if (!pick) return { outcome: { outcome: "cancelled" } };
			return { outcome: { outcome: "selected", optionId: pick.optionId } };
		})
		.onRequest(acp.methods.client.fs.readTextFile, async (ctx) => {
			try {
				return { content: await readTextFileContent(ctx.params.path) };
			} catch (error) {
				throw new Error(
					`fs/read_text_file failed for ${ctx.params.path}: ${error instanceof Error ? error.message : error}`,
				);
			}
		})
		.onRequest(acp.methods.client.fs.writeTextFile, async (ctx) => {
			try {
				await writeTextFileContent(ctx.params.path, ctx.params.content);
				return {};
			} catch (error) {
				throw new Error(
					`fs/write_text_file failed for ${ctx.params.path}: ${error instanceof Error ? error.message : error}`,
				);
			}
		});

	const webInput = Writable.toWeb(proc.stdin);
	const webOutput = Readable.toWeb(proc.stdout) as ReadableStream<Uint8Array>;
	const connection = app.connect(acp.ndJsonStream(webInput, webOutput));
	const entry: PooledConnection = { proc, connection, sessions: new Map(), activeTurns: 0 };
	current = entry;
	ensureExitHook();
	// Connections start referenced; each finished turn unrefs while idle.

	const onClose = () => {
		if (pool.get(key) === entry) pool.delete(key);
		proc.kill();
	};
	connection.closed.then(onClose, onClose);
	proc.once("exit", () => {
		if (pool.get(key) === entry) pool.delete(key);
		connection.close();
	});

	try {
		throwIfAborted(options.signal);
		// Aborting the handshake must not leave the subprocess running.
		const onAbortDuringInit = () => {
			connection.close();
			proc.kill();
		};
		options.signal?.addEventListener("abort", onAbortDuringInit, { once: true });
		try {
			await connection.agent.request(acp.methods.agent.initialize, {
				protocolVersion: acp.PROTOCOL_VERSION,
				clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
			});
		} finally {
			options.signal?.removeEventListener("abort", onAbortDuringInit);
		}
		throwIfAborted(options.signal);
	} catch (error) {
		if (pool.get(key) === entry) pool.delete(key);
		connection.close();
		proc.kill();
		throw new Error(`ACP agent "${label}" failed to initialize: ${error instanceof Error ? error.message : error}`);
	}
	// Publish only after the handshake: a pooled entry must never hand out a
	// connection whose agent has not completed `initialize`.
	pool.set(key, entry);
	return entry;
}

/**
 * Return the pooled connection for a transport, spawning it at most once.
 * Concurrent first callers await the same spawn: the pool would otherwise
 * overwrite one live process with another and lose track of the loser.
 */
function connectTransport(
	key: string,
	transport: AcpTransportConfig,
	options: AcpRunOptions,
): Promise<PooledConnection> {
	const pending = connecting.get(key);
	if (pending) return pending;
	const attempt = establishTransport(key, transport, options);
	connecting.set(key, attempt);
	// Drop the entry once settled so a failed spawn can be retried.
	void attempt
		.catch(() => {})
		.then(() => {
			if (connecting.get(key) === attempt) connecting.delete(key);
		});
	return attempt;
}

async function startSession(entry: PooledConnection, options: AcpRunOptions): Promise<acp.ActiveSession> {
	const cwd = options.cwd ?? process.cwd();
	return entry.connection.agent.buildSession(cwd).start();
}

export interface AcpSessionInfo {
	configOptions?: acp.SessionConfigOption[] | null;
	modes?: acp.SessionModeState | null;
}

/**
 * Open an ephemeral ACP session and report its config options and modes.
 * Used for capability discovery (e.g. the agent-advertised model catalog)
 * without disturbing any live pi session. Never throws for missing
 * capabilities; spawn/initialize failures reject.
 */
export async function fetchAcpSessionInfo(
	transport: AcpTransportConfig,
	options: { signal?: AbortSignal; env?: ProviderEnv; cwd?: string } = {},
): Promise<AcpSessionInfo> {
	const key = transportKey(transport, options.env);
	const entry = await connectTransport(key, transport, options);
	// Discovery never enters turn tracking, so bracket it explicitly: without
	// this the pooled child stays referenced and keeps the event loop alive.
	trackTurnStart(entry);
	try {
		const active = await startSession(entry, options);
		try {
			return { configOptions: active.newSessionResponse.configOptions, modes: active.newSessionResponse.modes };
		} finally {
			active.dispose();
			void entry.connection.agent
				.request(acp.methods.agent.session.close, { sessionId: active.sessionId })
				.catch(() => {});
		}
	} finally {
		trackTurnEnd(entry);
	}
}

/** Diff cumulative session totals against consumed turns to get this turn's usage. */
function toPromptResult(
	response: acp.PromptResponse,
	state: PooledSession,
	latestCost: number | undefined,
): AcpPromptResult {
	const cumulative = response.usage;
	const turnUsage: AcpTurnUsage = {
		input: Math.max(0, (cumulative?.inputTokens ?? state.consumed.input) - state.consumed.input),
		output: Math.max(0, (cumulative?.outputTokens ?? state.consumed.output) - state.consumed.output),
		cacheRead: Math.max(0, (cumulative?.cachedReadTokens ?? state.consumed.cacheRead) - state.consumed.cacheRead),
		cacheWrite: Math.max(0, (cumulative?.cachedWriteTokens ?? state.consumed.cacheWrite) - state.consumed.cacheWrite),
	};
	if (cumulative) {
		state.consumed = {
			input: cumulative.inputTokens,
			output: cumulative.outputTokens,
			cacheRead: cumulative.cachedReadTokens ?? state.consumed.cacheRead,
			cacheWrite: cumulative.cachedWriteTokens ?? state.consumed.cacheWrite,
			cost: state.consumed.cost,
		};
	}
	if (latestCost !== undefined) {
		turnUsage.costTotal = Math.max(0, latestCost - state.consumed.cost);
		state.consumed.cost = latestCost;
	}
	return { stopReason: response.stopReason, turnUsage };
}

/** Drop a pooled ACP session and close it on the agent side. */
function retireSession(entry: PooledConnection, sessionKey: string, state: PooledSession): void {
	if (entry.sessions.get(sessionKey) === state) entry.sessions.delete(sessionKey);
	state.session.dispose();
	void entry.connection.agent
		.request(acp.methods.agent.session.close, { sessionId: state.session.sessionId })
		.catch(() => {});
}

/** Close every pooled process. Used by tests; pi itself keeps the pool for its lifetime. */
export async function closeAcpPool(): Promise<void> {
	const entries = [...pool.values()];
	pool.clear();
	for (const entry of entries) {
		try {
			entry.connection.close();
		} catch {
			// Ignore close errors during teardown.
		}
		entry.proc.kill();
	}
}

/**
 * Prompt an ACP agent with transcript messages not yet sent to the session.
 * Returns the terminal stop reason and optional turn usage.
 */
export async function runAcpPrompt(
	transport: AcpTransportConfig,
	messages: readonly Message[],
	options: AcpRunOptions = {},
): Promise<AcpPromptResult> {
	const label = formatAcpCommand(transport);
	const key = transportKey(transport, options.env);
	const entry = await connectTransport(key, transport, options);
	trackTurnStart(entry);
	try {
		return await runTurn(entry, label, messages, options);
	} finally {
		trackTurnEnd(entry);
	}
}

/**
 * Prompt an ACP agent with transcript messages not yet sent to the session.
 * Returns the terminal stop reason and optional turn usage.
 */
async function runTurn(
	entry: PooledConnection,
	label: string,
	messages: readonly Message[],
	options: AcpRunOptions,
): Promise<AcpPromptResult> {
	const sessionKey = options.sessionKey ?? `ephemeral-${Date.now()}-${Math.floor(Math.random() * 2 ** 32)}`;
	const ephemeral = options.sessionKey === undefined;
	const cancellationSignal = options.signal;

	const systemPrompt = options.systemPrompt?.trim() || undefined;
	let state = entry.sessions.get(sessionKey);
	// A shorter transcript is a rewind (compaction, restore); a same-length
	// transcript whose last sent message changed is a branch or an edit. A
	// changed system prompt also invalidates what the agent was told. All three
	// leave the ACP session's context stale.
	const diverged =
		state !== undefined &&
		state.sentCount > 0 &&
		(messages.length < state.sentCount ||
			(messages.length === state.sentCount && messages[state.sentCount - 1] !== state.lastSent) ||
			(systemPrompt !== undefined && systemPrompt !== state.systemPrompt));
	if (diverged && state) {
		retireSession(entry, sessionKey, state);
		state = undefined;
	}
	if (!state) {
		throwIfAborted(options.signal);
		try {
			state = {
				session: await startSession(entry, options),
				sentCount: 0,
				systemPrompt,
				consumed: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
			};
		} catch (error) {
			if (cancellationSignal?.aborted) {
				throw new Error(`ACP agent "${label}" session creation was cancelled`);
			}
			throw new Error(
				`ACP agent "${label}" failed to create a session: ${error instanceof Error ? error.message : error}`,
			);
		}
		entry.sessions.set(sessionKey, state);
	}

	let delta = messages.slice(state.sentCount);
	if (state.sentCount > 0) {
		// The ACP session already holds the agent's own previous reply, so the
		// leading assistant messages of the delta are duplicates. Anything after
		// them is foreign history (a mid-session model switch) and still replays.
		let ownReplies = 0;
		while (ownReplies < delta.length && delta[ownReplies]?.role === "assistant") ownReplies++;
		delta = delta.slice(ownReplies);
	}
	const supportsImages = options.supportsImages ?? true;
	let blocks =
		options.blocks ??
		transcriptToAcpPrompt(delta, {
			systemPrompt: state.sentCount === 0 ? options.systemPrompt : undefined,
			supportsImages,
		});
	if (blocks.length === 0) blocks = transcriptToAcpPrompt(messages, { supportsImages });
	if (blocks.length === 0) throw new Error(`ACP agent "${label}" received an empty prompt`);
	// Advance only after the agent accepts the turn: on a failed prompt or a
	// cancellation the next turn must still carry these messages.
	const previousSentCount = state.sentCount;
	state.sentCount = messages.length;
	state.lastSent = messages[state.sentCount - 1];

	const active = state.session;
	const cancelListener = () => {
		void entry.connection.agent
			.notify(acp.methods.agent.session.cancel, { sessionId: active.sessionId })
			.catch(() => {});
	};
	const responsePromise = active.prompt(blocks, cancellationSignal ? { cancellationSignal } : undefined);
	// The prompt response is only awaited on the `stop` path; keep a handler
	// attached so a later rejection never surfaces as an unhandled rejection.
	responsePromise.catch(() => {});
	cancellationSignal?.addEventListener("abort", cancelListener, { once: true });
	entry.turnSignal = cancellationSignal;
	let latestCost: number | undefined;
	try {
		for (;;) {
			const message = await active.nextUpdate();
			if (message.kind === "stop") {
				const response = await responsePromise;
				return toPromptResult(response, state, latestCost);
			}
			throwIfAborted(cancellationSignal);
			if (message.update.sessionUpdate === "usage_update" && message.update.cost?.currency === "USD") {
				latestCost = message.update.cost.amount;
			}
			await options.onUpdate?.(message.notification);
		}
	} catch (error) {
		if (cancellationSignal?.aborted) {
			// Cancel and settle the in-flight prompt, then retire the session: how
			// much of the prompt the agent consumed is unknown, so reusing it
			// would overlap turns or resend on top of partial state.
			cancelListener();
			await responsePromise.catch(() => {});
			if (entry.sessions.get(sessionKey) === state) retireSession(entry, sessionKey, state);
			return { stopReason: "cancelled", turnUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
		}
		// Streaming failed: stop the agent's turn before reporting the error, so
		// its updates cannot overlap the next prompt.
		cancelListener();
		await responsePromise.catch(() => {});
		// Resend on the next turn: the rejected blocks were never accepted.
		state.sentCount = previousSentCount;
		state.lastSent = messages[previousSentCount - 1];
		throw new Error(`ACP agent "${label}" prompt failed: ${error instanceof Error ? error.message : error}`);
	} finally {
		entry.turnSignal = undefined;
		cancellationSignal?.removeEventListener("abort", cancelListener);
		if (ephemeral) retireSession(entry, sessionKey, state);
	}
}
