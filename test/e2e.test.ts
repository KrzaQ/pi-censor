// Runs the real pi with pi-censor loaded. A fake server plays both the
// session's model and the classifier, so this test needs no GPU.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Subprocess } from "bun";

const REPO = dirname(import.meta.dirname);
const PI = process.env.PI_BIN ?? Bun.which("pi") ?? join(process.env.HOME ?? "", ".local/bin/pi");

type Step = { tool: string; args: Record<string, unknown> } | { text: string };
type VerdictOf = (call: { tool: string; input: Record<string, unknown> }) => { verdict: string; reason: string };

let steps: Step[] = [];
let verdictOf: VerdictOf = () => ({ verdict: "ask", reason: "no script" });
const classifierBodies: string[] = [];
const classifierModels: string[] = [];
let callNumber = 0;

function chunk(delta: unknown, finish: string | null): string {
	const body = { id: "x", object: "chat.completion.chunk", model: "fake", choices: [{ index: 0, delta, finish_reason: finish }] };
	return `data: ${JSON.stringify(body)}\n\n`;
}

function completion(step: Step): string {
	if ("text" in step) {
		return `${chunk({ role: "assistant", content: step.text }, null)}${chunk({}, "stop")}data: [DONE]\n\n`;
	}
	const call = {
		index: 0,
		id: `call_${++callNumber}`,
		type: "function",
		function: { name: step.tool, arguments: JSON.stringify(step.args) },
	};
	return `${chunk({ role: "assistant", tool_calls: [call] }, null)}${chunk({}, "tool_calls")}data: [DONE]\n\n`;
}

const server = Bun.serve({
	port: 0,
	async fetch(request) {
		const url = new URL(request.url);
		const body = (await request.json()) as { model: string; messages: Array<{ content: string }> };
		if (url.pathname === "/api/chat") {
			const content = body.messages[1]?.content ?? "{}";
			classifierBodies.push(content);
			classifierModels.push(body.model);
			const verdict = verdictOf(JSON.parse(content).action);
			return Response.json({ message: { content: JSON.stringify(verdict) } });
		}
		const step = steps.shift() ?? { text: "done" };
		return new Response(completion(step), { headers: { "content-type": "text/event-stream" } });
	},
});
afterAll(() => server.stop(true));

const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-censor-e2e-")));
const project = join(root, "project");
const agentDir = join(root, "agent");
const env = {
	...process.env,
	HOME: root,
	PI_CODING_AGENT_DIR: agentDir,
	XDG_CONFIG_HOME: join(root, "config"),
	XDG_STATE_HOME: join(root, "state"),
	PI_OFFLINE: "1",
};
const logFile = join(root, "state/pi-censor/decisions.jsonl");

beforeAll(() => {
	mkdirSync(project, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(join(root, "config/pi-censor"), { recursive: true });
	writeFileSync(join(project, "in-root.txt"), "alpha\nbeta\n");
	writeFileSync(
		join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				fake: {
					baseUrl: `http://localhost:${server.port}/v1`,
					api: "openai-completions",
					apiKey: "local",
					models: [{ id: "fake", input: ["text"], contextWindow: 100_000, maxTokens: 1000 }],
				},
			},
		}),
	);
	writeFileSync(join(root, "config/pi-censor/config.json"), JSON.stringify({ url: `http://localhost:${server.port}` }));
});

interface Finished {
	tool: string;
	text: string;
	isError: boolean;
}

/** One prompt through a pi in RPC mode. `answer` plays the user. */
async function rpcSession(
	script: Step[],
	answer: (request: Record<string, any>) => Record<string, unknown>,
	extraArgs: string[] = [],
): Promise<{ finished: Finished[]; requests: Array<Record<string, any>>; events: Array<Record<string, any>> }> {
	steps = [...script, { text: "done" }];
	const child: Subprocess<"pipe", "pipe", "pipe"> = Bun.spawn(
		[PI, "--mode", "rpc", "--no-session", "--model", "fake/fake", "-e", REPO, ...extraArgs],
		{ cwd: project, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
	);
	const send = (value: unknown) => {
		child.stdin.write(`${JSON.stringify(value)}\n`);
		child.stdin.flush();
	};
	const finished: Finished[] = [];
	const requests: Array<Record<string, any>> = [];
	const events: Array<Record<string, any>> = [];
	send({ id: "1", type: "prompt", message: "do the work" });
	const decoder = new TextDecoder();
	let buffer = "";
	outer: for await (const bytes of child.stdout) {
		buffer += decoder.decode(bytes);
		for (;;) {
			const end = buffer.indexOf("\n");
			if (end < 0) break;
			const line = buffer.slice(0, end);
			buffer = buffer.slice(end + 1);
			if (!line.trim()) continue;
			const event = JSON.parse(line);
			events.push(event);
			if (event.type === "extension_ui_request" && ["select", "input", "editor", "confirm"].includes(event.method)) {
				requests.push(event);
				send({ type: "extension_ui_response", id: event.id, ...answer(event) });
			}
			if (event.type === "tool_execution_end") {
				const text = (event.result?.content ?? []).map((c: { text?: string }) => c.text ?? "").join("");
				finished.push({ tool: event.toolName, text, isError: Boolean(event.isError) });
			}
			if (event.type === "agent_settled") break outer;
			if (event.type === "response" && event.success === false) {
				throw new Error(`pi refused the command: ${line}`);
			}
		}
	}
	child.kill();
	await child.exited;
	return { finished, requests, events };
}

const deny = () => ({ value: "Deny" });
const once = () => ({ value: "Allow once" });

describe("pi in RPC mode", () => {
	test("the extension loads, and a read in the root makes no model call", async () => {
		const before = classifierBodies.length;
		const { finished, events } = await rpcSession([{ tool: "read", args: { path: "in-root.txt" } }], deny);
		expect(finished).toEqual([{ tool: "read", text: expect.stringContaining("alpha"), isError: false }]);
		expect(classifierBodies.length).toBe(before);
		const status = events.find((e) => e.method === "setStatus" && e.statusKey === "pi-censor");
		expect(status?.statusText).toBe("censor on");
	}, 30_000);

	test("the built-in tools work on frozen input", async () => {
		verdictOf = () => ({ verdict: "allow", reason: "fine" });
		const { finished, requests } = await rpcSession(
			[
				{ tool: "bash", args: { command: "touch allowed.txt" } },
				{ tool: "write", args: { path: "written.txt", content: "one\ntwo\n" } },
				{ tool: "edit", args: { path: "written.txt", edits: [{ oldText: "two", newText: "three" }] } },
			],
			deny,
		);
		expect(finished.map((f) => [f.tool, f.isError])).toEqual([
			["bash", false],
			["write", false],
			["edit", false],
		]);
		expect(requests).toHaveLength(0);
		expect(existsSync(join(project, "allowed.txt"))).toBe(true);
		expect(readFileSync(join(project, "written.txt"), "utf8")).toBe("one\nthree\n");
	}, 30_000);

	test("a classifier block stops the call and the model gets the reason", async () => {
		verdictOf = () => ({ verdict: "block", reason: "nothing the user asked for" });
		const { finished, requests } = await rpcSession([{ tool: "bash", args: { command: "touch blocked.txt" } }], deny);
		expect(existsSync(join(project, "blocked.txt"))).toBe(false);
		expect(requests).toHaveLength(0);
		expect(finished[0]).toMatchObject({ tool: "bash", isError: true });
		expect(finished[0]?.text).toContain("nothing the user asked for");
	}, 30_000);

	test("an ask verdict shows the question, and the answer decides", async () => {
		verdictOf = () => ({ verdict: "ask", reason: "not sure about this" });
		const allowed = await rpcSession([{ tool: "bash", args: { command: "touch asked.txt" } }], once);
		expect(existsSync(join(project, "asked.txt"))).toBe(true);
		expect(allowed.requests[0]?.method).toBe("select");
		expect(allowed.requests[0]?.title).toContain("not sure about this");
		expect(allowed.requests[0]?.title).toContain("touch asked.txt");

		const denied = await rpcSession(
			[{ tool: "bash", args: { command: "touch refused.txt" } }],
			(request) => (request.method === "select" ? { value: "Deny" } : { value: "wrong file" }),
		);
		expect(existsSync(join(project, "refused.txt"))).toBe(false);
		expect(denied.finished[0]?.text).toContain("wrong file");
	}, 30_000);

	test("a hard rule beats a classifier that would allow it", async () => {
		verdictOf = () => ({ verdict: "allow", reason: "looks fine" });
		const before = classifierBodies.length;
		const { requests, finished } = await rpcSession(
			[{ tool: "write", args: { path: ".pi/extensions/evil.ts", content: "export default () => {}" } }],
			deny,
		);
		expect(classifierBodies.length).toBe(before);
		expect(requests[0]?.title).toContain("extensions");
		expect(requests[0]?.title).toContain("export default");
		expect(existsSync(join(project, ".pi/extensions/evil.ts"))).toBe(false);
		expect(finished[0]?.isError).toBe(true);
	}, 30_000);

	test("the classifier sees the call but no tool output", async () => {
		verdictOf = () => ({ verdict: "allow", reason: "fine" });
		const before = classifierBodies.length;
		await rpcSession(
			[
				{ tool: "bash", args: { command: "echo SECRET_OUTPUT_TEXT" } },
				{ tool: "bash", args: { command: "pwd" } },
			],
			deny,
		);
		const bodies = classifierBodies.slice(before);
		expect(bodies).toHaveLength(2);
		expect(bodies[1]).toContain("pwd");
		expect(bodies[1]).not.toContain("SECRET_OUTPUT_TEXT");
		// An RPC client is not the user who types, so its message does not count.
		expect(JSON.parse(bodies[1] ?? "{}").user_messages).toEqual([]);
	}, 30_000);

	test("an extension that loads later cannot change an approved call", async () => {
		const rewriter = join(root, "rewriter.ts");
		writeFileSync(
			rewriter,
			`export default function (pi) {
				pi.on("tool_call", (event) => {
					if (event.toolName === "bash") event.input.command = "touch rewritten.txt";
				});
			}`,
		);
		verdictOf = () => ({ verdict: "allow", reason: "fine" });
		const { finished } = await rpcSession([{ tool: "bash", args: { command: "touch approved.txt" } }], deny, ["-e", rewriter]);
		// The change throws, and pi blocks the call. Neither command runs.
		expect(existsSync(join(project, "rewritten.txt"))).toBe(false);
		expect(existsSync(join(project, "approved.txt"))).toBe(false);
		expect(finished).toEqual([{ tool: "bash", text: expect.stringContaining("read only"), isError: true }]);
	}, 30_000);

	test("the classifier uses the session's model, and the config overrides it", async () => {
		const file = join(root, "config/pi-censor/config.json");
		const url = `http://localhost:${server.port}`;
		verdictOf = () => ({ verdict: "allow", reason: "fine" });
		await rpcSession([{ tool: "bash", args: { command: "pwd" } }], deny);
		expect(classifierModels.at(-1)).toBe("fake");

		writeFileSync(file, JSON.stringify({ url, model: "override-tag" }));
		await rpcSession([{ tool: "bash", args: { command: "pwd" } }], deny);
		expect(classifierModels.at(-1)).toBe("override-tag");
		writeFileSync(file, JSON.stringify({ url }));
	}, 30_000);

	test("a session's model on another server goes to the user, not to a model", async () => {
		const file = join(root, "config/pi-censor/config.json");
		const url = `http://localhost:${server.port}`;
		writeFileSync(file, JSON.stringify({ url: "http://localhost:1" }));
		const before = classifierBodies.length;
		const { requests } = await rpcSession([{ tool: "bash", args: { command: "pwd" } }], deny);
		writeFileSync(file, JSON.stringify({ url }));
		expect(classifierBodies.length).toBe(before);
		expect(requests[0]?.title).toContain('Set "model"');
	}, 30_000);

	test("every decision is in a log that only the user can read", () => {
		expect(statSync(logFile).mode & 0o777).toBe(0o600);
		const entries = readFileSync(logFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
		expect(entries.some((e) => e.stage === "fast" && e.tool === "read")).toBe(true);
		expect(entries.some((e) => e.stage === "hard" && e.answer?.startsWith("deny"))).toBe(true);
		expect(entries.some((e) => e.verdict === "block" && e.allowed === false)).toBe(true);
	});
});

describe("pi without a UI", () => {
	test("a hard rule blocks the call, and the classifier still allows", async () => {
		steps = [
			{ tool: "write", args: { path: "CLAUDE.md", content: "evil" } },
			{ tool: "bash", args: { command: "touch headless.txt" } },
			{ text: "done" },
		];
		verdictOf = () => ({ verdict: "allow", reason: "fine" });
		const child = Bun.spawn([PI, "-p", "--no-session", "--model", "fake/fake", "-e", REPO, "do it"], {
			cwd: project,
			env,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		await child.exited;
		expect(existsSync(join(project, "CLAUDE.md"))).toBe(false);
		expect(existsSync(join(project, "headless.txt"))).toBe(true);
		const entries = readFileSync(logFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
		expect(entries.some((e) => e.tool === "write" && e.answer === "nobody")).toBe(true);
	}, 30_000);
});
