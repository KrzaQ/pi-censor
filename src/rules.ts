// The fixed rules: what always goes to the user, and what runs without a
// model call. Everything else goes to the classifier.

import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { bashHardRule } from "./bash.ts";
import { followLinks, isInRoots, isInside, resolveLikePi } from "./paths.ts";

/** `by: "hint"` marks an allow that rests on the tool's own claim to be read-only. */
export type Rule = { kind: "allow"; by?: "hint" } | { kind: "ask"; reason: string } | { kind: "classify" };

const CLASSIFY: Rule = { kind: "classify" };

/** The places that the hard rules protect. */
export interface Protection {
	home: string;
	agentDir: string;
	/** pi-censor's own files. */
	ownDir: string;
	/** pi-censor's config directory. */
	configDir: string;
	/** pi-censor's log directory. */
	logDir: string;
}

export interface Scope {
	cwd: string;
	roots: readonly string[];
	/** The tool with this name is pi's own, not an extension's. */
	builtin: boolean;
	/** The tool declares itself read-only, and the config trusts that. */
	readOnly?: boolean;
}

const READ_ONLY = new Set(["read", "grep", "find", "ls"]);
const SHELLS = new Set(["bash", "powershell"]);

/** Keys of the input that hold a file path in tools that pi-censor does not know. */
const PATH_KEYS = ["path", "file_path", "filePath", "filename"];

const INSTRUCTIONS = new Set(["agents.md", "claude.md", "system.md", "append_system.md", "agents.override.md"]);

/** The settings keys that decide which extensions load. */
const LOADER_KEYS = ["extensions", "packages"];

/** The file name is one of pi's instruction files. */
export function isInstructions(path: string): boolean {
	return INSTRUCTIONS.has(basename(path).toLowerCase());
}

/** Why the path is sensitive, or undefined when it is not. */
export function sensitiveReason(path: string, protection: Protection): string | undefined {
	if (path === join(protection.agentDir, "auth.json")) return "it touches pi's saved credentials";
	if (path.endsWith("/.pi/agent/auth.json") || path.endsWith("/etc/shadow")) return "it touches a sensitive path";
	if (path.includes(".config/secrets")) return "it touches a sensitive path";
	for (const part of path.split("/")) {
		if (part === ".ssh" || part === ".gnupg" || part === ".aws") return "it touches a sensitive path";
		if (/^id_(rsa|ed25519)(\.|$)/.test(part)) return "it touches a sensitive path";
		if (/^\.env(\.|$)/.test(part) && !/\.(example|sample|template)$/.test(part)) {
			return "it touches a sensitive path";
		}
	}
	return undefined;
}

/** Why a write to the path could weaken pi-censor, or undefined. */
export function protectedReason(path: string, protection: Protection): string | undefined {
	const { agentDir, ownDir, configDir, logDir } = protection;
	if (isInside(path, ownDir)) return "it changes pi-censor's own files";
	if (isInside(path, configDir)) return "it changes pi-censor's config";
	if (isInside(path, logDir)) return "it changes pi-censor's log";
	if (isInside(path, join(agentDir, "extensions"))) return "it changes pi's extensions";
	if (path === join(agentDir, "trust.json")) return "it changes pi's project trust";
	if (/\/\.pi\/extensions(\/|$)/.test(path)) return "it changes a project's extensions";
	return undefined;
}

/** The path is a settings file that can load extensions. */
function isSettingsFile(path: string, protection: Protection): boolean {
	return path === join(protection.agentDir, "settings.json") || path.endsWith("/.pi/settings.json");
}

interface TextEdit {
	oldText: string;
	newText: string;
}

/** The replacements of an `edit` call, or undefined for an unknown shape. */
export function editsOf(input: Record<string, unknown>): TextEdit[] | undefined {
	const edits = input.edits ?? [{ oldText: input.oldText, newText: input.newText }];
	if (!Array.isArray(edits)) return undefined;
	const valid = edits.every((e) => typeof e?.oldText === "string" && typeof e?.newText === "string");
	return valid ? (edits as TextEdit[]) : undefined;
}

/** Apply the replacements exactly. Undefined when one of them does not match. */
export function applyExactly(text: string, edits: readonly TextEdit[]): string | undefined {
	let result = text.replaceAll("\r\n", "\n");
	for (const edit of edits) {
		const oldText = edit.oldText.replaceAll("\r\n", "\n");
		const at = result.indexOf(oldText);
		if (at < 0) return undefined;
		result = result.slice(0, at) + edit.newText.replaceAll("\r\n", "\n") + result.slice(at + oldText.length);
	}
	return result;
}

/** The call changes `extensions` or `packages`, or pi-censor cannot tell. */
function changesLoaderKeys(path: string, tool: string, input: Record<string, unknown>): boolean {
	let before = "{}";
	try {
		before = readFileSync(path, "utf8");
	} catch {
		// A new file: compare with an empty one.
	}
	let after: string | undefined;
	if (tool === "write") {
		after = typeof input.content === "string" ? input.content : undefined;
	} else {
		const edits = editsOf(input);
		after = edits && applyExactly(before, edits);
	}
	if (after === undefined) return true;
	try {
		const a = JSON.parse(before);
		const b = JSON.parse(after);
		return LOADER_KEYS.some((key) => JSON.stringify(a?.[key]) !== JSON.stringify(b?.[key]));
	} catch {
		return true;
	}
}

/** The path and the file it reaches. Both can match a rule. */
function spellings(raw: string, scope: Scope, protection: Protection): string[] {
	const path = resolveLikePi(raw, scope.cwd, protection.home);
	const real = followLinks(path);
	return real === path ? [path] : [path, real];
}

function writeRule(tool: string, raw: string, input: Record<string, unknown>, scope: Scope, protection: Protection): Rule {
	for (const path of spellings(raw, scope, protection)) {
		const reason = protectedReason(path, protection) ?? sensitiveReason(path, protection);
		if (reason) return { kind: "ask", reason };
		if (isInstructions(path)) return { kind: "ask", reason: "it changes an instruction file" };
		if (!isSettingsFile(path, protection)) continue;
		if (tool !== "write" && tool !== "edit") return { kind: "ask", reason: "it may change pi's settings" };
		if (changesLoaderKeys(path, tool, input)) return { kind: "ask", reason: "it changes which extensions pi loads" };
	}
	return CLASSIFY;
}

/** A glob that leaves its search path: `find` and `grep` take one next to it. */
function globEscapes(glob: string): boolean {
	return glob.startsWith("/") || glob.startsWith("~") || glob.includes("..");
}

function readRule(tool: string, input: Record<string, unknown>, scope: Scope, protection: Protection): Rule {
	const raw = input.path ?? ".";
	if (typeof raw !== "string") return CLASSIFY;
	const paths = spellings(raw, scope, protection);
	// The `grep` pattern is text to search for, not a path. It stays out.
	const glob = tool === "find" ? input.pattern : tool === "grep" ? input.glob : undefined;
	if (glob !== undefined && typeof glob !== "string") return CLASSIFY;
	for (const path of glob ? [...paths, glob] : paths) {
		const reason = sensitiveReason(path, protection);
		if (reason) return { kind: "ask", reason };
	}
	const inside = isInRoots(paths[0] ?? "", scope.roots);
	return scope.builtin && inside && !(glob && globEscapes(glob)) ? { kind: "allow" } : CLASSIFY;
}

/** What the fixed rules say about a call. */
export function fixedRule(tool: string, input: Record<string, unknown>, scope: Scope, protection: Protection): Rule {
	if (SHELLS.has(tool)) {
		if (typeof input.command !== "string") return CLASSIFY;
		const reason = bashHardRule(input.command, scope.cwd, protection);
		return reason ? { kind: "ask", reason } : CLASSIFY;
	}
	if (READ_ONLY.has(tool)) return readRule(tool, input, scope, protection);
	for (const key of PATH_KEYS) {
		const raw = input[key];
		if (typeof raw !== "string") continue;
		const rule = writeRule(tool, raw, input, scope, protection);
		if (rule.kind !== "classify") return rule;
	}
	// The hard rules above still apply. The tool's server makes this claim
	// about itself, so it counts only when the user turned it on.
	return scope.readOnly ? { kind: "allow", by: "hint" } : CLASSIFY;
}
