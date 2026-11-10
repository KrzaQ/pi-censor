// The decision log: one JSON line for each decision. It holds commands and
// file contents, so only the user can read it.

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export interface LogEntry {
	at: string;
	session: string;
	callId: string;
	parent?: string;
	tool: string;
	input: unknown;
	/** The step that decided: `session`, `fast`, `hint`, `hard`, `classifier`, `blocks` or `failure`. */
	stage: string;
	verdict?: string;
	reason?: string;
	classifierMs?: number;
	/** The user's answer: `once`, `session`, `deny` or `nobody`. */
	answer?: string;
	allowed: boolean;
}

export type Log = (entry: LogEntry) => void;

export function fileLog(dir: string): Log {
	const file = join(dir, "decisions.jsonl");
	return (entry) => {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
	};
}
