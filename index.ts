// pi-censor: decides about every tool call in a pi session.

import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Censor } from "./src/censor.ts";
import { classify } from "./src/classifier.ts";
import { configDir, loadConfig, logDir } from "./src/config.ts";
import { fileLog, type Log } from "./src/log.ts";
import { followLinks } from "./src/paths.ts";
import { ask } from "./src/question.ts";

/** A handler that loads after pi-censor must not change an approved call. */
function deepFreeze(value: unknown): void {
	if (typeof value !== "object" || value === null || Object.isFrozen(value)) return;
	Object.freeze(value);
	for (const child of Object.values(value)) deepFreeze(child);
}

export default function (pi: ExtensionAPI) {
	const home = followLinks(homedir());
	const protection = {
		home,
		agentDir: followLinks(getAgentDir()),
		ownDir: followLinks(dirname(fileURLToPath(import.meta.url))),
		configDir: followLinks(configDir(process.env, home)),
		logDir: followLinks(logDir(process.env, home)),
	};
	const { config, error: configError } = loadConfig(join(protection.configDir, "config.json"));
	const writeLog = fileLog(protection.logDir);

	let notify: ExtensionContext["ui"]["notify"] | undefined;
	let logFailed = false;
	const log: Log = (entry) => {
		try {
			writeLog(entry);
		} catch (error) {
			if (logFailed) return;
			logFailed = true;
			notify?.(`pi-censor cannot write its log: ${String(error)}`, "error");
		}
	};

	const censor = new Censor({
		protection,
		maxBlocks: config.maxBlocks,
		userMessages: config.userMessages,
		log,
	});

	pi.on("session_start", (_event, ctx) => {
		notify = (message, type) => ctx.ui.notify(message, type);
		if (!ctx.hasUI) return;
		ctx.ui.setStatus("pi-censor", "censor on");
		if (configError) ctx.ui.notify(`pi-censor: ${configError}. Every classifier call goes to you.`, "error");
	});

	pi.on("input", (event) => {
		censor.onInput(event.text, event.source);
		return { action: "continue" };
	});

	pi.on("tool_call", async (event, ctx) => {
		const tool = pi.getAllTools().find((candidate) => candidate.name === event.toolName);
		const decision = await censor.decide(
			{
				id: event.toolCallId,
				parentId: event.parentToolCallId,
				tool: event.toolName,
				input: event.input,
			},
			{
				cwd: ctx.cwd,
				session: ctx.sessionManager.getSessionId(),
				builtin: tool?.sourceInfo.source === "builtin",
				hints: tool?.annotations,
				// A tool that claims both read-only and destructive gets no trust.
				readOnly:
					config.trustReadOnlyHint &&
					tool?.annotations?.readOnlyHint === true &&
					tool.annotations.destructiveHint !== true,
				signal: ctx.signal,
				classify: (request, signal) => {
					if (configError) throw new Error(configError);
					return classify(config, ctx.modelRegistry, ctx.model, request, signal);
				},
				ask: ctx.hasUI
					? ({ call, parentTool, reason, cwd }) =>
							ask(ctx.ui, { tool: call.tool, input: call.input, parentTool, reason, cwd, home }, ctx.signal)
					: undefined,
			},
		);
		if (decision.block) return decision;
		deepFreeze(event.input);
		return undefined;
	});
}
