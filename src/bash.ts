// Rules for shell commands. No parser can find every write that a command
// makes, so these rules catch what they can and the classifier sees the rest.

import { existsSync } from "node:fs";
import { basename } from "node:path";
import { followLinks, resolveLikePi } from "./paths.ts";
import { isInstructions, protectedReason, type Protection, sensitiveReason } from "./rules.ts";

/**
 * True when the command is one plain command: no shell syntax outside quotes
 * that could run a second command or redirect a file. A port of goniec's
 * `is_single_command`.
 */
export function isPlainCommand(command: string): boolean {
	let quote: string | undefined;
	for (let i = 0; i < command.length; i++) {
		const c = command.charAt(i);
		if (quote === undefined) {
			if (c === "'" || c === '"') quote = c;
			else if (";&|<>()\n\\$`".includes(c)) return false;
		} else if (c === quote) {
			quote = undefined;
		} else if (quote === '"') {
			// Single quotes stop everything. In double quotes, `$` and
			// backticks still run commands.
			if (c === "$" || c === "`") return false;
			if (c === "\\") i++;
		}
	}
	return quote === undefined;
}

/** The command without quotes and with `~` and `$HOME` expanded. */
export function unquote(command: string, home: string): string {
	return command
		.replace(/\\\n/g, "")
		.replace(/['"\\]/g, "")
		.replace(/\$\{?HOME\}?/g, home)
		.replace(/(^|[\s=:;&|(<>])~(?=[/\s;&|)]|$)/g, `$1${home}`);
}

/** Commands and shapes that always go to the user. */
const WORD_START = String.raw`(?:^|[\s;&|(\x60])(?:[^\s;&|()]*/)?`;
const REST_OF_COMMAND = String.raw`[^;&|\n]*`;

function word(name: string): RegExp {
	return new RegExp(`${WORD_START}${name}(?:\\s|$)`);
}

const ALWAYS_ASK: ReadonlyArray<readonly [RegExp, string]> = [
	[word("sudo"), "it uses sudo"],
	[word("doas"), "it uses doas"],
	[word("docker"), "it uses docker"],
	[word("podman"), "it uses podman"],
	[word("systemctl"), "it uses systemctl"],
	[word("ssh"), "it reaches another host"],
	[word("scp"), "it reaches another host"],
	[word("sftp"), "it reaches another host"],
	[word("rsync"), "it reaches another host"],
	[word("eval"), "it evaluates text as code"],
	[word(String.raw`mkfs[.\w]*`), "it formats a disk"],
	// The deployed copy protects itself, not this repo. `make deploy` here is
	// how a session would replace the live extension with code it just edited.
	[new RegExp(`${WORD_START}g?make\\s${REST_OF_COMMAND}(?<=\\s)deploy(?:\\s|$)`), "it may deploy"],
	[new RegExp(`${WORD_START}rm\\s${REST_OF_COMMAND}(?<=\\s)-(?:[a-zA-Z]*[rR]|-recursive)`), "it removes a tree"],
	[new RegExp(`${WORD_START}rm\\s${REST_OF_COMMAND}(?<=\\s)-(?:[a-zA-Z]*f|-force)`), "it removes files by force"],
	[new RegExp(`${WORD_START}base64\\s${REST_OF_COMMAND}(?<=\\s)-(?:[a-zA-Z]*[dD]|-decode)`), "it decodes hidden text"],
	[
		new RegExp(`${WORD_START}git\\s${REST_OF_COMMAND}\\bpush\\s${REST_OF_COMMAND}(?<=\\s)(?:-[a-zA-Z]*f|--force|\\+)`),
		"it force-pushes",
	],
];

/** Programs that run the text on their standard input. */
const INTERPRETER = /^(?:sh|bash|zsh|dash|ksh|fish|python[\d.]*|perl|ruby|node|bun|deno|php|lua)$/;

/** A pipe into a shell runs whatever the left side prints. */
function pipesIntoInterpreter(command: string): boolean {
	const [, ...segments] = command.split(/(?<!\|)\|&?(?!\|)/);
	return segments.some((segment) => {
		const first = segment.trim().split(/\s+/)[0] ?? "";
		return INTERPRETER.test(basename(first));
	});
}

/** A shell that runs a download: `bash <(curl x)`, `sh -c "$(curl x)"`. */
const RUNS_SUBSTITUTION = new RegExp(
	`${WORD_START}(?:sh|bash|zsh|dash|ksh|source|\\.)\\s+(?:-\\S+\\s+)*(?:<\\(|\\$\\(|\\x60)|${WORD_START}(?:sh|bash|zsh|dash|ksh)\\s+-\\S*c\\s+(?:\\$\\(|\\x60)`,
);

/**
 * Text that names pi's config. A `cd` can change what a relative path means,
 * so these match as text and do not depend on the current directory.
 */
const PI_TEXT: ReadonlyArray<readonly [RegExp, string]> = [
	[/\.pi(?:\/agent)?\/extensions(?:\/|\s|$|[;&|)])/, "it may change pi's extensions"],
	[/\.pi(?:\/agent)?\/settings\.json/, "it may change pi's settings"],
	[/\.pi\/agent\/trust\.json/, "it may change pi's project trust"],
	[/\.pi\/agent\/auth\.json/, "it touches pi's saved credentials"],
	// The directory itself: `cd ~/.pi`, then a relative path.
	[/(?:^|[\s/=(])\.pi(?:\/agent)?\/?(?=$|[\s;&|)])/, "it names pi's config directory"],
	// A glob under it, or a glob for its name.
	[/(?:^|[\s/])\.pi\/\S*[*?[]/, "it names pi's config directory with a glob"],
	[/(?:^|[\s/])\.p[*?[]/, "it names pi's config directory with a glob"],
];

const WORD_SEPARATOR = /[\s;&|<>()=,\x60]+/;

/** Why a word of the command is a protected or sensitive path, or undefined. */
function wordReason(text: string, cwd: string, protection: Protection): string | undefined {
	let path: string;
	try {
		path = resolveLikePi(text, cwd, protection.home);
	} catch {
		return undefined;
	}
	// Inside a protected directory every bare word would resolve to a protected
	// path, also `ls`. A word only counts as a path when it looks like one.
	const isPath = text.includes("/") || existsSync(path);
	for (const candidate of new Set([path, followLinks(path)])) {
		const reason = (isPath ? protectedReason(candidate, protection) : undefined) ?? sensitiveReason(candidate, protection);
		if (reason) return reason;
		if (isInstructions(candidate)) return "it may change an instruction file";
		if (basename(candidate) === ".pi" || candidate === protection.agentDir) return "it names pi's config directory";
	}
	return undefined;
}

/** Why the command always goes to the user, or undefined. */
export function bashHardRule(command: string, cwd: string, protection: Protection): string | undefined {
	const text = unquote(command.trim(), protection.home);
	for (const [pattern, reason] of PI_TEXT) {
		if (pattern.test(text)) return reason;
	}
	for (const part of new Set(text.split(WORD_SEPARATOR))) {
		if (part === "") continue;
		const reason = wordReason(part, cwd, protection);
		if (reason) return reason;
	}
	for (const [pattern, reason] of ALWAYS_ASK) {
		if (pattern.test(text)) return reason;
	}
	if (pipesIntoInterpreter(text)) return "it pipes into a shell";
	if (RUNS_SUBSTITUTION.test(text)) return "it runs the output of a command";
	return undefined;
}
