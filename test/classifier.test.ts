import { describe, expect, test } from "bun:test";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	chooseModel,
	classify,
	MAX_CALL_CHARS,
	type Model,
	parseVerdict,
	type Registry,
	requestText,
	SYSTEM_PROMPT,
} from "../src/classifier.ts";
import { DEFAULTS, loadConfig, logDir } from "../src/config.ts";
import { fileLog } from "../src/log.ts";

const session = { provider: "local", id: "session-tag", maxTokens: 65_536, reasoning: false } as Model;
const other = { provider: "cloud", id: "luna", maxTokens: 1_000, reasoning: true } as Model;

interface Call {
	model: Model;
	context: { systemPrompt?: string; messages: Array<{ content: Array<{ text: string }> }> };
	options: Record<string, any>;
}

type Reply = (options: Record<string, any>) => unknown;

function registry(reply: Reply) {
	const calls: Call[] = [];
	const fake = {
		find: (provider: string, id: string) => (provider === "cloud" && id === "luna" ? other : undefined),
		complete: async (model: Model, context: Call["context"], options: Record<string, any>) => {
			calls.push({ model, context, options });
			return reply(options);
		},
	} as unknown as Registry;
	return { fake, calls };
}

const text = (content: string) => () => ({ stopReason: "stop", content: [{ type: "text", text: content }] });
const request = { userMessages: ["hi"], tool: "bash", input: { command: "ls" }, plain: true, cwd: "/p", roots: ["/p"] };

describe("classify", () => {
	test("reads a verdict", async () => {
		const { fake } = registry(text('{"verdict":"block","reason":"  no\\nway "}'));
		expect(await classify(DEFAULTS, fake, session, request)).toEqual({ verdict: "block", reason: "no way" });
	});

	test("sends a fresh context with the call and no tools", async () => {
		const { fake, calls } = registry(text('{"verdict":"allow","reason":"ok"}'));
		await classify(DEFAULTS, fake, session, request);
		const { context, options, model } = calls[0] as Call;
		expect(model).toBe(session);
		expect(context.systemPrompt).toBe(SYSTEM_PROMPT);
		expect(context.messages).toHaveLength(1);
		expect(Object.keys(context)).toEqual(["systemPrompt", "messages"]);
		expect(JSON.parse(context.messages[0]?.content[0]?.text ?? "{}")).toMatchObject({
			user_messages: ["hi"],
			action: { tool: "bash", input: { command: "ls" } },
			plain: true,
		});
		expect(options).toMatchObject({ cacheRetention: "none", maxTokens: 2048 });
	});

	test("gives a reasoning model no temperature, and respects its token limit", async () => {
		const { fake, calls } = registry(text('{"verdict":"allow","reason":"ok"}'));
		await classify(DEFAULTS, fake, session, request);
		await classify({ ...DEFAULTS, model: "cloud/luna" }, fake, session, request);
		expect(calls[0]?.options.temperature).toBe(0);
		expect("temperature" in (calls[1]?.options ?? {})).toBe(false);
		expect(calls[1]?.options.maxTokens).toBe(1000);
	});

	test("thinking in the answer does not count as text", async () => {
		const { fake } = registry(() => ({
			stopReason: "stop",
			content: [
				{ type: "thinking", thinking: '{"verdict":"allow","reason":"from the thinking"}' },
				{ type: "text", text: '{"verdict":"ask","reason":"from the text"}' },
			],
		}));
		expect((await classify(DEFAULTS, fake, session, request)).verdict).toBe("ask");
	});

	test("every kind of failure throws", async () => {
		const failing = async (reply: Reply) => classify(DEFAULTS, registry(reply).fake, session, request);
		await expect(failing(() => ({ stopReason: "error", errorMessage: "401", content: [] }))).rejects.toThrow("401");
		await expect(failing(() => ({ stopReason: "aborted", content: [] }))).rejects.toThrow("aborted");
		await expect(failing(() => ({ stopReason: "stop", content: [] }))).rejects.toThrow("no JSON");
		await expect(failing(text("not json"))).rejects.toThrow("no JSON");
		await expect(failing(text('{"verdict":"maybe"}'))).rejects.toThrow("no verdict");
		await expect(failing(text('{"verdict":"allow"} and {"verdict":"block"}'))).rejects.toThrow();
		await expect(
			failing(() => {
				throw new Error("no key for this provider");
			}),
		).rejects.toThrow("no key");
	});

	test("a slow model times out", async () => {
		const { fake } = registry(
			(options) =>
				new Promise((_resolve, reject) => {
					options.signal.addEventListener("abort", () => reject(options.signal.reason));
				}),
		);
		await expect(classify({ ...DEFAULTS, timeoutMs: 20 }, fake, session, request)).rejects.toThrow();
	});

	test("the turn's signal cancels it", async () => {
		const { fake } = registry(
			(options) =>
				new Promise((_resolve, reject) => {
					options.signal.addEventListener("abort", () => reject(new Error("cancelled")));
				}),
		);
		const controller = new AbortController();
		const result = classify(DEFAULTS, fake, session, request, controller.signal);
		controller.abort();
		await expect(result).rejects.toThrow("cancelled");
	});

	test("a call that is too long is not cut", async () => {
		const { fake, calls } = registry(text("{}"));
		const long = { ...request, input: { content: "x".repeat(MAX_CALL_CHARS + 1) } };
		await expect(classify(DEFAULTS, fake, session, long)).rejects.toThrow("over");
		expect(calls).toHaveLength(0);
	});
});

describe("chooseModel", () => {
	const { fake } = registry(text("{}"));

	test("the session's model classifies by default, wherever it runs", () => {
		expect(chooseModel(DEFAULTS, fake, session)).toBe(session);
		expect(chooseModel(DEFAULTS, fake, other)).toBe(other);
	});

	test("the config overrides it", () => {
		expect(chooseModel({ ...DEFAULTS, model: "cloud/luna" }, fake, session)).toBe(other);
		expect(chooseModel({ ...DEFAULTS, model: "cloud/luna" }, fake, undefined)).toBe(other);
	});

	test("a model that pi does not know throws", () => {
		expect(() => chooseModel({ ...DEFAULTS, model: "cloud/none" }, fake, session)).toThrow("does not know");
		expect(() => chooseModel(DEFAULTS, fake, undefined)).toThrow("no model");
	});

	test("an id may hold a slash", () => {
		const find = (provider: string, id: string) => (provider === "router" && id === "vendor/m" ? other : undefined);
		const router = { ...fake, find } as Registry;
		expect(chooseModel({ ...DEFAULTS, model: "router/vendor/m" }, router, session)).toBe(other);
	});
});

describe("parseVerdict", () => {
	test("finds the object in code fences and around text", () => {
		expect(parseVerdict('```json\n{"verdict":"allow","reason":"ok"}\n```').verdict).toBe("allow");
		expect(parseVerdict('Here it is: {"verdict":"ask","reason":"x"}').verdict).toBe("ask");
	});

	test("keeps the reason to one short line", () => {
		const { reason } = parseVerdict(JSON.stringify({ verdict: "ask", reason: `a\n${"b".repeat(500)}` }));
		expect(reason).not.toContain("\n");
		expect(reason).toHaveLength(200);
	});

	test("a missing reason is empty", () => {
		expect(parseVerdict('{"verdict":"ask"}')).toEqual({ verdict: "ask", reason: "" });
	});
});

describe("request text", () => {
	test("holds no tool output, because the request has no field for it", () => {
		expect(Object.keys(JSON.parse(requestText(request))).sort()).toEqual([
			"action",
			"cwd",
			"plain",
			"roots",
			"user_messages",
		]);
	});
});

describe("config", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-censor-config-"));
	const file = join(dir, "config.json");

	test("a missing file gives the defaults", () => {
		expect(loadConfig(file)).toEqual({ config: DEFAULTS });
		expect(DEFAULTS.model).toBeUndefined();
	});

	test("a file overrides the defaults", () => {
		writeFileSync(file, '{"model":"cloud/luna","maxBlocks":5}');
		expect(loadConfig(file).config).toMatchObject({ model: "cloud/luna", maxBlocks: 5 });
	});

	test("a bad file is an error, not a silent default", () => {
		for (const text of ["not json", "[]", '{"model":3}', '{"model":"no-slash"}', '{"timeoutMs":"x"}', '{"maxBlocks":-1}']) {
			writeFileSync(file, text);
			expect(loadConfig(file).error).toBeString();
		}
	});

	test("the log follows XDG_STATE_HOME", () => {
		expect(logDir({ XDG_STATE_HOME: "/s" }, "/h")).toBe("/s/pi-censor");
		expect(logDir({}, "/h")).toBe("/h/.local/state/pi-censor");
	});
});

describe("log", () => {
	test("appends JSON lines that only the user can read", async () => {
		const dir = join(mkdtempSync(join(tmpdir(), "pi-censor-log-")), "new");
		const log = fileLog(dir);
		const entry = { at: "t", session: "s", callId: "c", tool: "bash", input: {}, stage: "fast", allowed: true };
		log(entry);
		log(entry);
		const file = join(dir, "decisions.jsonl");
		expect(statSync(file).mode & 0o777).toBe(0o600);
		expect(statSync(dir).mode & 0o777).toBe(0o700);
		const lines = (await Bun.file(file).text()).trim().split("\n");
		expect(lines).toHaveLength(2);
		expect(JSON.parse(lines[0] ?? "")).toEqual(entry);
	});
});
