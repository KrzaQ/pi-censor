// The question to the user.

import { readFileSync } from "node:fs";
import { generateDiffString } from "@earendil-works/pi-coding-agent";
import { resolveLikePi } from "./paths.ts";
import { applyExactly, editsOf } from "./rules.ts";

export interface Question {
	tool: string;
	input: Record<string, unknown>;
	/** The parent's tool name, for a nested call. */
	parentTool?: string;
	/** Why the call goes to the user. */
	reason: string;
	cwd: string;
	home: string;
}

export type Answer = { answer: "once" } | { answer: "session" } | { answer: "deny"; reason?: string };

/** The part of `ctx.ui` that the question uses. */
export interface QuestionUI {
	select(title: string, options: string[], opts?: { signal?: AbortSignal }): Promise<string | undefined>;
	input(title: string, placeholder?: string, opts?: { signal?: AbortSignal }): Promise<string | undefined>;
	editor(title: string, prefill?: string): Promise<string | undefined>;
}

const PREVIEW_LINES = 40;

const ALLOW_ONCE = "Allow once";
const ALLOW_SESSION = "Allow this exact call for this session";
const DENY = "Deny";
const SHOW_ALL = "Show the whole call";

/** Show control characters as text, so that a command cannot redraw the question. */
export function visible(text: string): string {
	return text.replace(
		/[\x00-\x08\x0b-\x1f\x7f-\x9f‪-‮⁦-⁩]/g,
		(c) => `\\u{${c.charCodeAt(0).toString(16)}}`,
	);
}

/** The diff of a `write` or `edit`, when pi-censor can compute it. */
export function callDiff(question: Question): string | undefined {
	const { tool, input } = question;
	if ((tool !== "write" && tool !== "edit") || typeof input.path !== "string") return undefined;
	try {
		const path = resolveLikePi(input.path, question.cwd, question.home);
		let before = "";
		try {
			before = readFileSync(path, "utf8").replaceAll("\r\n", "\n");
		} catch {
			// A new file.
		}
		const edits = tool === "edit" ? editsOf(input) : undefined;
		const after = tool === "write" ? input.content : edits && applyExactly(before, edits);
		return typeof after === "string" ? generateDiffString(before, after.replaceAll("\r\n", "\n")).diff : undefined;
	} catch {
		return undefined;
	}
}

/** The text of the call, without the question around it. */
export function callText(question: Question): string {
	const { tool, input } = question;
	const lines = [question.parentTool ? `${tool} (called by ${question.parentTool})` : tool];
	const diff = callDiff(question);
	if (typeof input.command === "string") lines.push(input.command);
	else if (diff !== undefined) lines.push(String(input.path), diff);
	else lines.push(JSON.stringify(input, null, 2));
	return visible(lines.join("\n"));
}

/** Ask the user. A dialog that is closed or cancelled denies the call. */
export async function ask(ui: QuestionUI, question: Question, signal?: AbortSignal): Promise<Answer> {
	const text = callText(question);
	const lines = text.split("\n");
	const cut = lines.length > PREVIEW_LINES;
	const preview = cut
		? `${lines.slice(0, PREVIEW_LINES).join("\n")}\n… ${lines.length - PREVIEW_LINES} more lines`
		: text;
	const title = `pi-censor: ${visible(question.reason)}\n\n${preview}`;
	const options = [ALLOW_ONCE, ALLOW_SESSION, DENY, ...(cut ? [SHOW_ALL] : [])];
	for (;;) {
		const choice = await ui.select(title, options, { signal });
		if (choice === ALLOW_ONCE) return { answer: "once" };
		if (choice === ALLOW_SESSION) return { answer: "session" };
		if (choice === SHOW_ALL) {
			await ui.editor("The whole call. Nothing you change here takes effect.", text);
			continue;
		}
		if (choice !== DENY) return { answer: "deny" };
		const reason = await ui.input("Why? This goes to the model. Leave it empty to give no reason.", "", { signal });
		return reason?.trim() ? { answer: "deny", reason: reason.trim() } : { answer: "deny" };
	}
}
