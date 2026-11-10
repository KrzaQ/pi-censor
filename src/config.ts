// pi-censor's config and where its files live.

import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Which of the user's typed messages the classifier sees. */
export interface UserMessageLimits {
	/** The first messages of the session. They usually set the task. */
	first: number;
	/** The last messages. They show where the work is now. */
	last: number;
	/** The size of one message. A longer one loses its middle. */
	chars: number;
}

export interface Config {
	/** The classifier model as `provider/id`. Unset means the session's own model. */
	model?: string;
	timeoutMs: number;
	/** How many classifier blocks in a row run before the next one asks the user. */
	maxBlocks: number;
	/** A tool that declares itself read-only runs without a classifier call. */
	trustReadOnlyHint: boolean;
	userMessages: UserMessageLimits;
}

export const DEFAULTS: Config = {
	timeoutMs: 30_000,
	maxBlocks: 3,
	trustReadOnlyHint: false,
	userMessages: { first: 2, last: 10, chars: 2_000 },
};

/** Below this, a clipped message would be mostly its marker. */
const MIN_MESSAGE_CHARS = 200;

function invalidLimits(value: unknown): string | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return "userMessages must be an object";
	const limits = value as Record<string, unknown>;
	const minimum = { first: 0, last: 1, chars: MIN_MESSAGE_CHARS };
	for (const [key, least] of Object.entries(minimum)) {
		const number = limits[key];
		if (key in limits && !(Number.isInteger(number) && (number as number) >= least)) {
			return `userMessages.${key} must be a whole number of at least ${least}`;
		}
	}
	return undefined;
}

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
	if ("model" in value && !(typeof value.model === "string" && value.model.includes("/"))) {
		return "model must be provider/id";
	}
	if ("trustReadOnlyHint" in value && typeof value.trustReadOnlyHint !== "boolean") {
		return "trustReadOnlyHint must be true or false";
	}
	if ("userMessages" in value) {
		const problem = invalidLimits(value.userMessages);
		if (problem) return problem;
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
		const config = value as Partial<Config>;
		// A partial userMessages block keeps the defaults for the numbers it leaves out.
		return { config: { ...DEFAULTS, ...config, userMessages: { ...DEFAULTS.userMessages, ...config.userMessages } } };
	} catch (error) {
		return { config: DEFAULTS, error: `cannot parse ${file}: ${String(error)}` };
	}
}
