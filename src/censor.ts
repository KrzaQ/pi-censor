// The order of decisions: hard rules, fast allow, classifier, then the user.

import { isPlainCommand } from "./bash.ts";
import type { ClassifierRequest, Verdict } from "./classifier.ts";
import type { Log, LogEntry } from "./log.ts";
import { sessionRoots } from "./paths.ts";
import type { Answer } from "./question.ts";
import { fixedRule, type Protection } from "./rules.ts";

/** How many of the user's latest messages the classifier sees, and how much of each. */
const USER_MESSAGES = 12;
const USER_MESSAGE_CHARS = 2_000;

/** How many calls pi-censor remembers, to name the parent of a nested call. */
const REMEMBERED_CALLS = 256;

export interface Call {
	id: string;
	parentId?: string;
	tool: string;
	input: Record<string, unknown>;
}

/** What pi-censor needs from pi for one call. */
export interface CallContext {
	cwd: string;
	session: string;
	/** The tool with this name is pi's own, not an extension's. */
	builtin: boolean;
	hints?: unknown;
	signal?: AbortSignal;
	/** Ask the classifier. It uses the session's model at the time of this call. */
	classify: (request: ClassifierRequest, signal?: AbortSignal) => Promise<Verdict>;
	/** Undefined when nobody can answer. */
	ask?: (question: AskRequest) => Promise<Answer>;
}

export interface AskRequest {
	call: Call;
	parentTool?: string;
	reason: string;
	cwd: string;
}

export interface Deps {
	protection: Protection;
	maxBlocks: number;
	log: Log;
}

export type Decision = { block: false } | { block: true; reason: string };

const ALLOW: Decision = { block: false };

type Outcome = Pick<LogEntry, "stage" | "verdict" | "reason" | "classifierMs">;

export class Censor {
	private readonly userMessages: string[] = [];
	private readonly sessionAllowed = new Set<string>();
	private readonly toolOfCall = new Map<string, string>();
	private blocksInARow = 0;
	/** Tool calls can run in parallel. The user gets one question at a time. */
	private questions: Promise<unknown> = Promise.resolve();

	constructor(private readonly deps: Deps) {}

	/**
	 * Record a message. Only what the user typed counts: a tool call cannot forge
	 * this source, and a message from an extension or an RPC client has another one.
	 */
	onInput(text: string, source: string): void {
		if (source !== "interactive") return;
		this.userMessages.push(text.slice(0, USER_MESSAGE_CHARS));
		if (this.userMessages.length > USER_MESSAGES) this.userMessages.shift();
	}

	async decide(call: Call, context: CallContext): Promise<Decision> {
		this.remember(call);
		if (this.sessionAllowed.has(callKey(call))) {
			this.log(call, context, { stage: "session" }, true);
			return ALLOW;
		}
		const roots = sessionRoots(context.cwd, this.deps.protection.home);
		const scope = { cwd: context.cwd, roots, builtin: context.builtin };
		const rule = fixedRule(call.tool, call.input, scope, this.deps.protection);
		if (rule.kind === "allow") {
			this.log(call, context, { stage: "fast" }, true);
			return ALLOW;
		}
		if (rule.kind === "ask") return this.toUser(call, context, { stage: "hard", reason: rule.reason });
		return this.classifyCall(call, context, roots);
	}

	private async classifyCall(call: Call, context: CallContext, roots: readonly string[]): Promise<Decision> {
		const started = performance.now();
		let verdict: Verdict;
		try {
			verdict = await context.classify(this.request(call, context, roots), context.signal);
		} catch (error) {
			const reason = `the classifier failed: ${error instanceof Error ? error.message : String(error)}`;
			return this.toUser(call, context, { stage: "failure", reason });
		}
		const outcome: Outcome = {
			stage: "classifier",
			verdict: verdict.verdict,
			reason: verdict.reason,
			classifierMs: Math.round(performance.now() - started),
		};
		if (verdict.verdict === "allow") {
			this.blocksInARow = 0;
			this.log(call, context, outcome, true);
			return ALLOW;
		}
		if (verdict.verdict === "ask") return this.toUser(call, context, outcome);
		if (this.blocksInARow >= this.deps.maxBlocks) {
			return this.toUser(call, context, { ...outcome, stage: "blocks" });
		}
		this.blocksInARow++;
		this.log(call, context, outcome, false);
		return { block: true, reason: `pi-censor blocked this call: ${verdict.reason || "no reason given"}` };
	}

	private request(call: Call, context: CallContext, roots: readonly string[]): ClassifierRequest {
		const command = call.input.command;
		return {
			userMessages: [...this.userMessages],
			tool: call.tool,
			input: call.input,
			parentTool: this.parentTool(call),
			plain: typeof command === "string" ? isPlainCommand(command) : undefined,
			cwd: context.cwd,
			roots,
			hints: context.hints,
		};
	}

	private toUser(call: Call, context: CallContext, outcome: Outcome): Promise<Decision> {
		const question = this.questions.then(() => this.askUser(call, context, outcome));
		this.questions = question.catch(() => undefined);
		return question;
	}

	private async askUser(call: Call, context: CallContext, outcome: Outcome): Promise<Decision> {
		const { ask } = context;
		const reason = outcome.reason || "the classifier is not sure";
		if (!ask) {
			this.log(call, context, outcome, false, "nobody");
			return { block: true, reason: `pi-censor blocked this call: ${reason}. Nobody can approve it here.` };
		}
		// The user may have allowed this exact call while it waited for its turn.
		if (this.sessionAllowed.has(callKey(call))) {
			this.log(call, context, { ...outcome, stage: "session" }, true);
			return ALLOW;
		}
		const answer = await ask({ call, parentTool: this.parentTool(call), reason, cwd: context.cwd });
		this.blocksInARow = 0;
		if (answer.answer === "deny") {
			this.log(call, context, outcome, false, answer.reason ? `deny: ${answer.reason}` : "deny");
			return { block: true, reason: answer.reason ? `The user denied this call: ${answer.reason}` : "The user denied this call." };
		}
		if (answer.answer === "session") this.sessionAllowed.add(callKey(call));
		this.log(call, context, outcome, true, answer.answer);
		return ALLOW;
	}

	private remember(call: Call): void {
		this.toolOfCall.set(call.id, call.tool);
		if (this.toolOfCall.size <= REMEMBERED_CALLS) return;
		const oldest = this.toolOfCall.keys().next().value;
		if (oldest !== undefined) this.toolOfCall.delete(oldest);
	}

	private parentTool(call: Call): string | undefined {
		return call.parentId === undefined ? undefined : (this.toolOfCall.get(call.parentId) ?? call.parentId);
	}

	private log(call: Call, context: CallContext, outcome: Outcome, allowed: boolean, answer?: string): void {
		this.deps.log({
			at: new Date().toISOString(),
			session: context.session,
			callId: call.id,
			parent: this.parentTool(call),
			tool: call.tool,
			input: call.input,
			...outcome,
			answer,
			allowed,
		});
	}
}

/** The identity of a call for "allow this exact call". */
function callKey(call: Call): string {
	return JSON.stringify([call.tool, call.input]);
}
