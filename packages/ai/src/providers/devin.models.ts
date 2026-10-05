/**
 * Devin offline model baseline: families (stable slugs) plus known aliases.
 * Edit this file to update the out-of-the-box catalog; live refresh replaces
 * it with the agent-advertised variant list. Run `devin models list` to see
 * current families.
 */

import type { AcpChatModelDefinition } from "../acp/provider.ts";

export const DEVIN_COMMAND = "devin";
export const DEVIN_ACP_ARGS = ["acp"];

/** Offline baseline: model families (stable slugs). Refresh replaces this with the live variant catalog. */
const DEVIN_FAMILY_MODELS: AcpChatModelDefinition[] = [
	{
		id: "adaptive",
		name: "Adaptive",
		input: ["text", "image"],
		transport: { args: [...DEVIN_ACP_ARGS, "--model", "adaptive"] },
	},
	{ id: "swe-2", name: "SWE-2", reasoning: true, transport: { args: [...DEVIN_ACP_ARGS, "--model", "swe-2"] } },
	{
		id: "swe-2-medium",
		name: "SWE-2 Medium",
		reasoning: true,
		transport: { args: [...DEVIN_ACP_ARGS, "--model", "swe-2-medium"] },
	},
	{
		id: "swe-2-max",
		name: "SWE-2 Max",
		reasoning: true,
		transport: { args: [...DEVIN_ACP_ARGS, "--model", "swe-2-max"] },
	},
	{
		id: "swe-1.7-lightning",
		name: "SWE-1.7 Lightning",
		transport: { args: [...DEVIN_ACP_ARGS, "--model", "swe-1.7-lightning"] },
	},
	{
		id: "claude-fable-5.1",
		name: "Claude Fable 5.1",
		transport: { args: [...DEVIN_ACP_ARGS, "--model", "claude-fable-5.1"] },
	},
	{
		id: "claude-opus-5.5",
		name: "Claude Opus 5.5",
		transport: { args: [...DEVIN_ACP_ARGS, "--model", "claude-opus-5.5"] },
	},
	{ id: "gpt-6-astra", name: "GPT-6 Astra", transport: { args: [...DEVIN_ACP_ARGS, "--model", "gpt-6-astra"] } },
	{ id: "gpt-6-sol", name: "GPT-6 Sol", transport: { args: [...DEVIN_ACP_ARGS, "--model", "gpt-6-sol"] } },
	{ id: "gpt-6-luna", name: "GPT-6 Luna", transport: { args: [...DEVIN_ACP_ARGS, "--model", "gpt-6-luna"] } },
	{ id: "kimi-k3", name: "Kimi K3", transport: { args: [...DEVIN_ACP_ARGS, "--model", "kimi-k3"] } },
	{ id: "glm-5.2", name: "GLM-5.2", transport: { args: [...DEVIN_ACP_ARGS, "--model", "glm-5.2"] } },
	{ id: "glm-5.3", name: "GLM-5.3", transport: { args: [...DEVIN_ACP_ARGS, "--model", "glm-5.3"] } },
	{
		id: "claude-sonnet-5.5",
		name: "Claude Sonnet 5.5",
		transport: { args: [...DEVIN_ACP_ARGS, "--model", "claude-sonnet-5.5"] },
	},
	{
		id: "gemini-3.8-flash",
		name: "Gemini 3.8 Flash",
		transport: { args: [...DEVIN_ACP_ARGS, "--model", "gemini-3.8-flash"] },
	},
	{
		id: "claude-opus-4.7",
		name: "Claude Opus 4.7",
		transport: { args: [...DEVIN_ACP_ARGS, "--model", "claude-opus-4.7"] },
	},
	{
		id: "claude-opus-4.8",
		name: "Claude Opus 4.8",
		transport: { args: [...DEVIN_ACP_ARGS, "--model", "claude-opus-4.8"] },
	},
	{ id: "claude-opus-5", name: "Claude Opus 5", transport: { args: [...DEVIN_ACP_ARGS, "--model", "claude-opus-5"] } },
	{
		id: "claude-fable-5",
		name: "Claude Fable 5",
		transport: { args: [...DEVIN_ACP_ARGS, "--model", "claude-fable-5"] },
	},
	{
		id: "claude-sonnet-5",
		name: "Claude Sonnet 5",
		transport: { args: [...DEVIN_ACP_ARGS, "--model", "claude-sonnet-5"] },
	},
	{
		id: "gemini-3.5-flash",
		name: "Gemini 3.5 Flash",
		transport: { args: [...DEVIN_ACP_ARGS, "--model", "gemini-3.5-flash"] },
	},
	{
		id: "gemini-3.6-flash",
		name: "Gemini 3.6 Flash",
		transport: { args: [...DEVIN_ACP_ARGS, "--model", "gemini-3.6-flash"] },
	},
	{
		id: "gemini-3.7-flash",
		name: "Gemini 3.7 Flash",
		transport: { args: [...DEVIN_ACP_ARGS, "--model", "gemini-3.7-flash"] },
	},
	{ id: "gpt-5.6-sol", name: "GPT-5.6 Sol", transport: { args: [...DEVIN_ACP_ARGS, "--model", "gpt-5.6-sol"] } },
	{ id: "gpt-5.6-terra", name: "GPT-5.6 Terra", transport: { args: [...DEVIN_ACP_ARGS, "--model", "gpt-5.6-terra"] } },
	{ id: "gpt-5.6-luna", name: "GPT-5.6 Luna", transport: { args: [...DEVIN_ACP_ARGS, "--model", "gpt-5.6-luna"] } },
	{ id: "gpt-6.1-sol", name: "GPT-6.1 Sol", transport: { args: [...DEVIN_ACP_ARGS, "--model", "gpt-6.1-sol"] } },
	{ id: "grok-4.5", name: "Grok 4.5", transport: { args: [...DEVIN_ACP_ARGS, "--model", "grok-4.5"] } },
	{ id: "grok-4.6", name: "Grok 4.6", transport: { args: [...DEVIN_ACP_ARGS, "--model", "grok-4.6"] } },
	{ id: "grok-4.7", name: "Grok 4.7", transport: { args: [...DEVIN_ACP_ARGS, "--model", "grok-4.7"] } },
	{ id: "inkling", name: "Inkling", transport: { args: [...DEVIN_ACP_ARGS, "--model", "inkling"] } },
	{ id: "glm-5.3-flash", name: "GLM-5.3 Flash", transport: { args: [...DEVIN_ACP_ARGS, "--model", "glm-5.3-flash"] } },
	{
		id: "deepseek-v4-flash",
		name: "DeepSeek V4 Flash",
		transport: { args: [...DEVIN_ACP_ARGS, "--model", "deepseek-v4-flash"] },
	},
	{
		id: "deepseek-v4.1-flash",
		name: "DeepSeek V4.1 Flash",
		transport: { args: [...DEVIN_ACP_ARGS, "--model", "deepseek-v4.1-flash"] },
	},
	{ id: "swe-1.7", name: "SWE-1.7", transport: { args: [...DEVIN_ACP_ARGS, "--model", "swe-1.7"] } },
	{ id: "fusion", name: "Fusion", transport: { args: [...DEVIN_ACP_ARGS, "--model", "fusion"] } },
	{
		id: "claude-opus-4.6",
		name: "Claude Opus 4.6",
		transport: { args: [...DEVIN_ACP_ARGS, "--model", "claude-opus-4.6"] },
	},
	{ id: "gpt-5.4", name: "GPT-5.4", transport: { args: [...DEVIN_ACP_ARGS, "--model", "gpt-5.4"] } },
	{ id: "gpt-5.5", name: "GPT-5.5", transport: { args: [...DEVIN_ACP_ARGS, "--model", "gpt-5.5"] } },
	{ id: "gpt-5.4-mini", name: "GPT-5.4 Mini", transport: { args: [...DEVIN_ACP_ARGS, "--model", "gpt-5.4-mini"] } },
	{
		id: "claude-sonnet-4.6",
		name: "Claude Sonnet 4.6",
		transport: { args: [...DEVIN_ACP_ARGS, "--model", "claude-sonnet-4.6"] },
	},
	{ id: "gpt-5.2", name: "GPT-5.2", transport: { args: [...DEVIN_ACP_ARGS, "--model", "gpt-5.2"] } },
	{
		id: "claude-opus-4.5",
		name: "Claude Opus 4.5",
		transport: { args: [...DEVIN_ACP_ARGS, "--model", "claude-opus-4.5"] },
	},
	{
		id: "claude-haiku-4.5",
		name: "Claude Haiku 4.5",
		transport: { args: [...DEVIN_ACP_ARGS, "--model", "claude-haiku-4.5"] },
	},
	{ id: "gpt-4.1", name: "GPT-4.1", transport: { args: [...DEVIN_ACP_ARGS, "--model", "gpt-4.1"] } },
	{ id: "gpt-5.1", name: "GPT-5.1", transport: { args: [...DEVIN_ACP_ARGS, "--model", "gpt-5.1"] } },
	{ id: "gpt-5.3-codex", name: "GPT-5.3-Codex", transport: { args: [...DEVIN_ACP_ARGS, "--model", "gpt-5.3-codex"] } },
	{ id: "kimi-k2.6", name: "Kimi K2.6", transport: { args: [...DEVIN_ACP_ARGS, "--model", "kimi-k2.6"] } },
	{ id: "kimi-k2.7", name: "Kimi K2.7", transport: { args: [...DEVIN_ACP_ARGS, "--model", "kimi-k2.7"] } },
	{
		id: "nemotron-3-ultra",
		name: "Nemotron 3 Ultra",
		transport: { args: [...DEVIN_ACP_ARGS, "--model", "nemotron-3-ultra"] },
	},
	{ id: "swe-1.6", name: "SWE-1.6", transport: { args: [...DEVIN_ACP_ARGS, "--model", "swe-1.6"] } },
	{ id: "swe-1.6-fast", name: "SWE-1.6 Fast", transport: { args: [...DEVIN_ACP_ARGS, "--model", "swe-1.6-fast"] } },
	{
		id: "gemini-3.1-pro",
		name: "Gemini 3.1 Pro",
		transport: { args: [...DEVIN_ACP_ARGS, "--model", "gemini-3.1-pro"] },
	},
	{
		id: "gemini-3-flash",
		name: "Gemini 3 Flash",
		transport: { args: [...DEVIN_ACP_ARGS, "--model", "gemini-3-flash"] },
	},
	{
		id: "deepseek-v4-pro",
		name: "DeepSeek V4 Pro",
		transport: { args: [...DEVIN_ACP_ARGS, "--model", "deepseek-v4-pro"] },
	},
];

/** Family aliases (`--model` accepts slugs, aliases, and partial names). */
const DEVIN_ALIAS_MODELS: AcpChatModelDefinition[] = [
	{ id: "swe", name: "SWE-2 (alias)", reasoning: true, transport: { args: [...DEVIN_ACP_ARGS, "--model", "swe"] } },
	{ id: "fable", name: "Claude Fable 5.1 (alias)", transport: { args: [...DEVIN_ACP_ARGS, "--model", "fable"] } },
	{ id: "gemini", name: "Gemini 3.8 Flash (alias)", transport: { args: [...DEVIN_ACP_ARGS, "--model", "gemini"] } },
	{ id: "opus", name: "Claude Opus 5 (alias)", transport: { args: [...DEVIN_ACP_ARGS, "--model", "opus"] } },
	{ id: "claude", name: "Claude Sonnet 5 (alias)", transport: { args: [...DEVIN_ACP_ARGS, "--model", "claude"] } },
	{ id: "sonnet", name: "Claude Sonnet 5 (alias)", transport: { args: [...DEVIN_ACP_ARGS, "--model", "sonnet"] } },
	{ id: "gpt", name: "GPT-5.5 (alias)", transport: { args: [...DEVIN_ACP_ARGS, "--model", "gpt"] } },
	{ id: "codex", name: "GPT-5.3-Codex (alias)", transport: { args: [...DEVIN_ACP_ARGS, "--model", "codex"] } },
];

export const DEVIN_BASELINE_MODELS: AcpChatModelDefinition[] = [...DEVIN_FAMILY_MODELS, ...DEVIN_ALIAS_MODELS];
