import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ask, callDiff, callText, type Question, type QuestionUI, visible } from "../src/question.ts";
import { sandbox } from "./helpers.ts";

const box = sandbox();
const base = { cwd: box.cwd, home: box.protection.home, reason: "because" };
writeFileSync(join(box.cwd, "a.txt"), "one\ntwo\n");

function ui(choices: Array<string | undefined>, typed?: string) {
	const titles: string[] = [];
	const options: string[][] = [];
	const shown: Array<string | undefined> = [];
	const fake: QuestionUI = {
		select: async (title, list) => {
			titles.push(title);
			options.push(list);
			return choices.shift();
		},
		input: async () => typed,
		editor: async (_title, text) => {
			shown.push(text);
			return text;
		},
	};
	return { fake, titles, options, shown };
}

const bash: Question = { ...base, tool: "bash", input: { command: "rm x" } };

describe("answers", () => {
	test("each choice gives its answer", async () => {
		expect(await ask(ui(["Allow once"]).fake, bash)).toEqual({ answer: "once" });
		const session = "Allow this exact call for this session";
		expect(await ask(ui([session]).fake, bash)).toEqual({ answer: "session" });
		expect(await ask(ui(["Deny"], " too risky ").fake, bash)).toEqual({ answer: "deny", reason: "too risky" });
		expect(await ask(ui(["Deny"], "").fake, bash)).toEqual({ answer: "deny" });
		expect(await ask(ui(["Deny"]).fake, bash)).toEqual({ answer: "deny" });
	});

	test("a closed dialog denies", async () => {
		expect(await ask(ui([undefined]).fake, bash)).toEqual({ answer: "deny" });
	});
});

describe("what the question shows", () => {
	test("the reason and the command", async () => {
		const { fake, titles, options } = ui(["Allow once"]);
		await ask(fake, bash);
		expect(titles[0]).toContain("because");
		expect(titles[0]).toContain("rm x");
		expect(options[0]).toHaveLength(3);
	});

	test("the parent of a nested call", () => {
		expect(callText({ ...bash, parentTool: "codemode" })).toContain("bash (called by codemode)");
	});

	test("the diff of a write and an edit", () => {
		const write = callDiff({ ...base, tool: "write", input: { path: "a.txt", content: "one\nthree\n" } });
		expect(write).toContain("-");
		expect(write).toContain("two");
		expect(write).toContain("three");
		const edit = callDiff({
			...base,
			tool: "edit",
			input: { path: "a.txt", edits: [{ oldText: "two", newText: "2" }] },
		});
		expect(edit).toContain("two");
		expect(edit).toContain("2");
	});

	test("a new file shows its content", () => {
		const text = callText({ ...base, tool: "write", input: { path: "new.txt", content: "hello" } });
		expect(text).toContain("new.txt");
		expect(text).toContain("hello");
	});

	test("an edit that does not match shows the raw input", () => {
		const input = { path: "a.txt", edits: [{ oldText: "nope", newText: "x" }] };
		expect(callText({ ...base, tool: "edit", input })).toContain('"oldText": "nope"');
	});

	test("an MCP call shows its input", () => {
		expect(callText({ ...base, tool: "mcp__x", input: { query: "hello" } })).toContain('"query": "hello"');
	});

	test("a long call offers the whole text", async () => {
		const command = Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n");
		const { fake, titles, options, shown } = ui(["Show the whole call", "Allow once"]);
		const question = { ...bash, input: { command } };
		expect(await ask(fake, question)).toEqual({ answer: "once" });
		expect(titles[0]).toContain("more lines");
		expect(titles[0]).not.toContain("line99");
		expect(options[0]).toContain("Show the whole call");
		expect(shown[0]).toContain("line99");
		expect(titles).toHaveLength(2);
	});

	test("control characters cannot redraw the question", () => {
		expect(visible("ok\x1b[2Jx\r")).toBe("ok\\u{1b}[2Jx\\u{d}");
		expect(visible("a‮b")).toBe("a\\u{202e}b");
		expect(visible("a\nb\tc")).toBe("a\nb\tc");
		expect(callText({ ...bash, input: { command: "echo \x1b[2J" } })).not.toContain("\x1b");
	});
});
