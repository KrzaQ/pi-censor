// pi-censor's config and where its files live.

import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface Config {
	/** The Ollama server. */
	url: string;
	/** The classifier model. Unset means the session's own model. */
	model?: string;
	timeoutMs: number;
	/** How many classifier blocks in a row run before the next one asks the user. */
	maxBlocks: number;
}

export const DEFAULTS: Config = {
	url: "http://localhost:11434",
	timeoutMs: 30_000,
	maxBlocks: 3,
};

export function configDir(env: NodeJS.ProcessEnv, home: string): string {
	return join(env.XDG_CONFIG_HOME || join(home, ".config"), "pi-censor");
}

export function logDir(env: NodeJS.ProcessEnv, home: string): string {
	return join(env.XDG_STATE_HOME || join(home, ".local", "state"), "pi-censor");
}

export interface LoadedConfig {
	config: Config;
	/** Set when the file exists but pi-censor cannot use it. */
	error?: string;
}

function invalid(value: Record<string, unknown>): string | undefined {
	for (const key of ["url", "model"] as const) {
		if (key in value && typeof value[key] !== "string") return `${key} must be a string`;
	}
	for (const key of ["timeoutMs", "maxBlocks"] as const) {
		const number = value[key];
		if (key in value && !(typeof number === "number" && Number.isFinite(number) && number >= 0)) {
			return `${key} must be a number`;
		}
	}
	return undefined;
}

export function loadConfig(file: string): LoadedConfig {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { config: DEFAULTS };
		return { config: DEFAULTS, error: `cannot read ${file}: ${String(error)}` };
	}
	try {
		const value: unknown = JSON.parse(text);
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			return { config: DEFAULTS, error: `${file} is not a JSON object` };
		}
		const problem = invalid(value as Record<string, unknown>);
		if (problem) return { config: DEFAULTS, error: `${file}: ${problem}` };
		return { config: { ...DEFAULTS, ...value } };
	} catch (error) {
		return { config: DEFAULTS, error: `cannot parse ${file}: ${String(error)}` };
	}
}
