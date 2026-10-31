import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	chatUrl,
	chooseModel,
	classify,
	MAX_CALL_CHARS,
	parseVerdict,
	requestText,
	SYSTEM_PROMPT,
} from "../src/classifier.ts";
import { DEFAULTS, loadConfig, logDir } from "../src/config.ts";
import { fileLog } from "../src/log.ts";

type Reply = () => Response | Promise<Response>;
let reply: Reply = () => Response.json({});
let lastBody: any;
const server = Bun.serve({
	port: 0,
	async fetch(request) {
		lastBody = await request.json();
		return reply();
	},
});
afterAll(() => server.stop(true));

const config = { ...DEFAULTS, url: `http://localhost:${server.port}`, model: "small", timeoutMs: 200 };
const request = { userMessages: ["hi"], tool: "bash", input: { command: "ls" }, plain: true, cwd: "/p", roots: ["/p"] };
const answer = (content: unknown) => Response.json({ message: { content } });

describe("classify", () => {
	test("reads a verdict", async () => {
		reply = () => answer('{"verdict":"block","reason":"  no\\nway "}');
		expect(await classify(config, request)).toEqual({ verdict: "block", reason: "no way" });
	});

	test("asks for JSON with the system prompt first and no thinking", async () => {
		reply = () => answer('{"verdict":"allow","reason":"ok"}');
		await classify(config, request);
		expect(lastBody).toMatchObject({ model: "small", stream: false, think: false });
		expect(lastBody.format.properties.verdict.enum).toEqual(["allow", "block", "ask"]);
		expect(lastBody.messages[0]).toEqual({ role: "system", content: SYSTEM_PROMPT });
		expect(JSON.parse(lastBody.messages[1].content)).toMatchObject({
			user_messages: ["hi"],
			action: { tool: "bash", input: { command: "ls" } },
			plain: true,
		});
	});

	test("every kind of failure throws", async () => {
		reply = () => new Response("nope", { status: 500 });
		await expect(classify(config, request)).rejects.toThrow("500");
		reply = () => answer("not json");
		await expect(classify(config, request)).rejects.toThrow();
		reply = () => answer('{"verdict":"maybe"}');
		await expect(classify(config, request)).rejects.toThrow("no verdict");
		reply = () => answer(null);
		await expect(classify(config, request)).rejects.toThrow("no message");
		reply = () => new Response("not json");
		await expect(classify(config, request)).rejects.toThrow();
	});

	test("a slow server times out", async () => {
		reply = async () => {
			await Bun.sleep(1000);
			return answer('{"verdict":"allow","reason":"late"}');
		};
		await expect(classify(config, request)).rejects.toThrow();
	});

	test("an unreachable server throws", async () => {
		await expect(classify({ ...config, url: "http://localhost:1" }, request)).rejects.toThrow();
	});

	test("the turn's signal cancels it", async () => {
		reply = async () => {
			await Bun.sleep(1000);
			return answer('{"verdict":"allow","reason":"late"}');
		};
		const slow = { ...config, timeoutMs: 5000 };
		const controller = new AbortController();
		const result = classify(slow, request, undefined, controller.signal);
		controller.abort();
		await expect(result).rejects.toThrow();
	});

	test("a call that is too long is not cut", async () => {
		const long = { ...request, input: { content: "x".repeat(MAX_CALL_CHARS + 1) } };
		await expect(classify(config, long)).rejects.toThrow("over");
	});
});

describe("chooseModel", () => {
	const local = { id: "session-tag", baseUrl: "http://localhost:11434/v1" };
	const cloud = { id: "claude-opus-5-5", baseUrl: "https://api.anthropic.com" };

	test("the session's model classifies by default", () => {
		expect(chooseModel(DEFAULTS, local)).toBe("session-tag");
		expect(chooseModel(DEFAULTS, { ...local, baseUrl: "http://127.0.0.1:11434/v1" })).toBe("session-tag");
		const lan = { ...DEFAULTS, url: "http://10.0.0.5:11434" };
		expect(chooseModel(lan, { ...local, baseUrl: "http://10.0.0.5:11434/v1" })).toBe("session-tag");
	});

	test("the config overrides it", () => {
		expect(chooseModel({ ...DEFAULTS, model: "small" }, local)).toBe("small");
		expect(chooseModel({ ...DEFAULTS, model: "small" }, cloud)).toBe("small");
		expect(chooseModel({ ...DEFAULTS, model: "small" }, undefined)).toBe("small");
	});

	test("a model on another server never classifies", () => {
		expect(() => chooseModel(DEFAULTS, cloud)).toThrow('Set "model"');
		expect(() => chooseModel(DEFAULTS, { ...local, baseUrl: "http://localhost:8080/v1" })).toThrow('Set "model"');
		expect(() => chooseModel(DEFAULTS, { ...local, baseUrl: "http://10.0.0.5:11434/v1" })).toThrow('Set "model"');
		expect(() => chooseModel(DEFAULTS, { ...local, baseUrl: "not a url" })).toThrow('Set "model"');
		expect(() => chooseModel(DEFAULTS, undefined)).toThrow("no model");
	});

	test("classify sends the chosen model, and a cloud session sends nothing", async () => {
		reply = () => answer('{"verdict":"allow","reason":"ok"}');
		const unset = { ...config, model: undefined };
		await classify(unset, request, { id: "session-tag", baseUrl: `${config.url}/v1` });
		expect(lastBody.model).toBe("session-tag");
		lastBody = undefined;
		await expect(classify(unset, request, cloud)).rejects.toThrow('Set "model"');
		expect(lastBody).toBeUndefined();
	});
});

describe("parseVerdict", () => {
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

describe("chatUrl", () => {
	test("accepts an OpenAI-style base URL", () => {
		expect(chatUrl("http://h:1")).toBe("http://h:1/api/chat");
		expect(chatUrl("http://h:1/")).toBe("http://h:1/api/chat");
		expect(chatUrl("http://h:1/v1")).toBe("http://h:1/api/chat");
		expect(chatUrl("http://h:1/v1/")).toBe("http://h:1/api/chat");
	});
});

describe("config", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-censor-config-"));
	const file = join(dir, "config.json");

	test("a missing file gives the defaults", () => {
		expect(loadConfig(file)).toEqual({ config: DEFAULTS });
	});

	test("a file overrides the defaults", () => {
		writeFileSync(file, '{"model":"small","maxBlocks":5}');
		expect(loadConfig(file).config).toMatchObject({ model: "small", maxBlocks: 5, url: DEFAULTS.url });
	});

	test("a bad file is an error, not a silent default", () => {
		for (const text of ["not json", "[]", '{"model":3}', '{"timeoutMs":"x"}', '{"maxBlocks":-1}']) {
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
