import { describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { followLinks, resolveLikePi, sessionRoots } from "../src/paths.ts";
import { fixedRule, type Rule, type Scope } from "../src/rules.ts";
import { sandbox } from "./helpers.ts";

const box = sandbox();
const { cwd, protection } = box;
const { home, agentDir, ownDir, logDir, configDir } = protection;
writeFileSync(join(cwd, "src/main.ts"), "x");
writeFileSync(join(cwd, "CLAUDE.md"), "x");
writeFileSync(join(cwd, ".env"), "x");
writeFileSync(join(box.base, "outside.txt"), "x");

const scope: Scope = { cwd, roots: [cwd], builtin: true };
const rule = (tool: string, input: Record<string, unknown>, s: Scope = scope): Rule =>
	fixedRule(tool, input, s, protection);
const ALLOW: Rule = { kind: "allow" };
const CLASSIFY: Rule = { kind: "classify" };
const asks = { kind: "ask", reason: expect.any(String) } as Rule;

describe("roots", () => {
	test("the current directory is a root", () => {
		expect(sessionRoots(cwd, home)).toEqual([cwd]);
		expect(sessionRoots(join(cwd, "src"), home)).toEqual([join(cwd, "src")]);
	});

	test("home, its parents, / and /tmp are not roots", () => {
		expect(sessionRoots(home, home)).toEqual([]);
		expect(sessionRoots(box.base, home)).toEqual([]);
		expect(sessionRoots("/", home)).toEqual([]);
		expect(sessionRoots("/tmp", home)).toEqual([]);
	});
});

describe("resolveLikePi", () => {
	test("matches pi's spellings", () => {
		expect(resolveLikePi("@~/x", cwd, home)).toBe(join(home, "x"));
		expect(resolveLikePi("~", cwd, home)).toBe(home);
		expect(resolveLikePi("a/../b", cwd, home)).toBe(join(cwd, "b"));
		expect(resolveLikePi("/etc x", cwd, home)).toBe("/etc x");
		expect(resolveLikePi(pathToFileURL("/etc/hosts").href, cwd, home)).toBe("/etc/hosts");
	});
});

describe("followLinks", () => {
	test("follows a dangling link and the links above a new file", () => {
		const target = join(agentDir, "extensions");
		mkdirSync(target, { recursive: true });
		symlinkSync(join(target, "new.ts"), join(cwd, "dangling"));
		symlinkSync(target, join(cwd, "dir"));
		expect(followLinks(join(cwd, "dangling"))).toBe(join(target, "new.ts"));
		expect(followLinks(join(cwd, "dir", "new.ts"))).toBe(join(target, "new.ts"));
	});
});

describe("fast allow", () => {
	test("read-only tools pass only inside the root", () => {
		expect(rule("read", { path: "src/main.ts" })).toEqual(ALLOW);
		expect(rule("read", { path: join(cwd, "src/main.ts") })).toEqual(ALLOW);
		expect(rule("read", { path: "CLAUDE.md" })).toEqual(ALLOW);
		expect(rule("ls", {})).toEqual(ALLOW);
		expect(rule("ls", { path: "src" })).toEqual(ALLOW);
		expect(rule("grep", { pattern: "x" })).toEqual(ALLOW);
		expect(rule("find", { pattern: "*.ts" })).toEqual(ALLOW);
		expect(rule("read", { path: "../../outside.txt" })).toEqual(CLASSIFY);
		expect(rule("read", { path: "/etc/hostname" })).toEqual(CLASSIFY);
		expect(rule("read", { path: "~/.config/gh/hosts.yml" })).toEqual(CLASSIFY);
		expect(rule("read", { path: "no-such-file" })).toEqual(CLASSIFY);
		expect(rule("grep", { pattern: "api_key", path: "~" })).toEqual(CLASSIFY);
	});

	test("a link out of the root is outside", () => {
		symlinkSync(join(box.base, "outside.txt"), join(cwd, "link"));
		expect(rule("read", { path: "link" })).toEqual(CLASSIFY);
	});

	test("no root means no fast allow", () => {
		const open = { cwd: home, roots: [], builtin: true };
		expect(rule("read", { path: "project/src/main.ts" }, open)).toEqual(CLASSIFY);
	});

	test("an extension's tool with a built-in name goes to the classifier", () => {
		expect(rule("read", { path: "src/main.ts" }, { ...scope, builtin: false })).toEqual(CLASSIFY);
	});

	test("globs stay under their root", () => {
		expect(rule("find", { pattern: "**/*.ts" })).toEqual(ALLOW);
		expect(rule("find", { pattern: "../**" })).toEqual(CLASSIFY);
		expect(rule("find", { pattern: "/home/**" })).toEqual(CLASSIFY);
		expect(rule("find", { pattern: "~/**" })).toEqual(CLASSIFY);
		expect(rule("grep", { pattern: "x", glob: "../*" })).toEqual(CLASSIFY);
	});

	test("the grep pattern is not a path", () => {
		expect(rule("grep", { pattern: "\\.env|\\.ssh" })).toEqual(ALLOW);
		expect(rule("grep", { pattern: ".env" })).toEqual(ALLOW);
	});

	test("input of an odd type goes to the classifier", () => {
		expect(rule("read", { path: 3 })).toEqual(CLASSIFY);
		expect(rule("find", { pattern: {} })).toEqual(CLASSIFY);
	});
});

describe("sensitive paths", () => {
	test("always ask, also inside the root", () => {
		expect(rule("read", { path: ".env" })).toEqual(asks);
		expect(rule("read", { path: "~/.ssh/id_ed25519" })).toEqual(asks);
		expect(rule("read", { path: join(agentDir, "auth.json") })).toEqual(asks);
		expect(rule("ls", { path: "~/.ssh" })).toEqual(asks);
		expect(rule("find", { pattern: "**/.env" })).toEqual(asks);
		expect(rule("grep", { pattern: "x", glob: "**/.aws/**" })).toEqual(asks);
		expect(rule("write", { path: "~/.ssh/authorized_keys", content: "x" })).toEqual(asks);
	});
});

describe("hard rules on writes", () => {
	const write = (path: string, content = "x") => rule("write", { path, content });

	test("pi-censor's protection", () => {
		expect(write(join(agentDir, "extensions/x.ts"))).toEqual(asks);
		expect(write(join(agentDir, "trust.json"))).toEqual(asks);
		expect(write(join(ownDir, "index.ts"))).toEqual(asks);
		expect(write(join(configDir, "config.json"))).toEqual(asks);
		expect(write(join(logDir, "decisions.jsonl"))).toEqual(asks);
		expect(write(".pi/extensions/evil.ts")).toEqual(asks);
		expect(write("/any/where/.pi/extensions/evil.ts")).toEqual(asks);
	});

	test("pi's spellings of a path do not get past the rule", () => {
		expect(write("@~/.pi/agent/trust.json")).toEqual(asks);
		expect(write(pathToFileURL(join(agentDir, "trust.json")).href)).toEqual(asks);
		expect(write("~/.pi/agent/../agent/trust.json")).toEqual(asks);
	});

	test("a link does not get past the rule", () => {
		expect(write("dangling")).toEqual(asks);
		expect(write("dir/new.ts")).toEqual(asks);
	});

	test("instruction files, in any directory and any case", () => {
		for (const name of ["AGENTS.md", "CLAUDE.md", "SYSTEM.md", "APPEND_SYSTEM.md", "AGENTS.override.md", "claude.md"]) {
			expect(write(`deep/down/${name}`)).toEqual(asks);
			expect(rule("edit", { path: name, edits: [] })).toEqual(asks);
		}
	});

	test("the rest goes to the classifier", () => {
		expect(write("notes.md")).toEqual(CLASSIFY);
		expect(write("~/.pi/agent/models.json")).toEqual(CLASSIFY);
		expect(write("~/.pi/agent/keybindings.json")).toEqual(CLASSIFY);
		expect(rule("something_new", {})).toEqual(CLASSIFY);
	});

	test("an unknown tool with a path field is checked too", () => {
		expect(rule("mcp__fs__write", { path: "~/.pi/agent/trust.json" })).toEqual(asks);
		expect(rule("mcp__fs__write", { file_path: "CLAUDE.md" })).toEqual(asks);
		expect(rule("mcp__fs__write", { path: "~/.pi/agent/settings.json" })).toEqual(asks);
	});
});

describe("settings.json", () => {
	const settings = join(agentDir, "settings.json");
	writeFileSync(settings, JSON.stringify({ theme: "dark", extensions: ["./a.ts"] }, null, 2));
	const edit = (oldText: string, newText: string) => rule("edit", { path: settings, edits: [{ oldText, newText }] });

	test("a change to another key goes to the classifier", () => {
		expect(edit('"dark"', '"light"')).toEqual(CLASSIFY);
		const next = JSON.stringify({ theme: "light", extensions: ["./a.ts"] });
		expect(rule("write", { path: settings, content: next })).toEqual(CLASSIFY);
	});

	test("a change to the loader keys is a hard rule", () => {
		expect(edit('"./a.ts"', '"./b.ts"')).toEqual(asks);
		expect(edit('"dark"', '"dark", "packages": ["npm:evil"]')).toEqual(asks);
		// JSON keeps the last copy of a key, so a second key must come after the first.
		expect(edit('"./a.ts"\n  ]', '"./a.ts"\n  ],\n  "ext\\u0065nsions": []')).toEqual(asks);
		expect(edit('"dark"', '"dark", "ext\\u0065nsions": []')).toEqual(CLASSIFY);
		expect(rule("write", { path: settings, content: "{}" })).toEqual(asks);
	});

	test("what pi-censor cannot check is a hard rule", () => {
		expect(edit("no such text", "x")).toEqual(asks);
		expect(edit('"dark"', "not json")).toEqual(asks);
		expect(rule("edit", { path: settings, edits: "[]" })).toEqual(asks);
		expect(rule("write", { path: settings, content: "not json" })).toEqual(asks);
	});

	test("a project's settings count too", () => {
		expect(rule("write", { path: ".pi/settings.json", content: '{"extensions":["x"]}' })).toEqual(asks);
		expect(rule("write", { path: ".pi/settings.json", content: '{"theme":"x"}' })).toEqual(CLASSIFY);
	});
});

describe("the read-only hint", () => {
	const trusted = { ...scope, readOnly: true };

	test("a trusted hint allows a tool without a classifier call", () => {
		expect(rule("mcp__docs__search", { query: "x" }, trusted)).toEqual({ kind: "allow", by: "hint" });
	});

	test("without trust the tool goes to the classifier", () => {
		expect(rule("mcp__docs__search", { query: "x" })).toEqual(CLASSIFY);
	});

	test("the hard rules still win", () => {
		expect(rule("mcp__fs__read", { path: "~/.ssh/id_ed25519" }, trusted)).toEqual(asks);
		expect(rule("mcp__fs__read", { path: "~/.pi/agent/trust.json" }, trusted)).toEqual(asks);
		expect(rule("mcp__fs__read", { file_path: "CLAUDE.md" }, trusted)).toEqual(asks);
	});

	test("a shell never counts as read-only", () => {
		expect(rule("bash", { command: "ls" }, trusted)).toEqual(CLASSIFY);
		expect(rule("powershell", { command: "ls" }, trusted)).toEqual(CLASSIFY);
	});

	test("the built-in read tools keep their own rules", () => {
		expect(rule("read", { path: "/etc/hostname" }, trusted)).toEqual(CLASSIFY);
	});
});

describe("shell tools", () => {
	test("never fast allow, and powershell counts", () => {
		expect(rule("bash", { command: "ls" })).toEqual(CLASSIFY);
		expect(rule("bash", { command: "sudo x" })).toEqual(asks);
		expect(rule("powershell", { command: "cat ~/.pi/agent/trust.json" })).toEqual(asks);
		expect(rule("bash", { command: 3 })).toEqual(CLASSIFY);
	});
});
