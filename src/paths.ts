// Path handling for the rules. A rule is only as good as its idea of which
// file a call reaches, so this code follows pi's own resolution.

import { readlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const UNICODE_SPACES = /[  -   　]/g;

/** Resolve a tool's path as pi does (`resolveToCwd` in `utils/paths.js`). */
export function resolveLikePi(input: string, cwd: string, home: string): string {
	let path = input.replace(UNICODE_SPACES, " ");
	if (path.startsWith("@")) path = path.slice(1);
	if (path === "~") path = home;
	else if (path.startsWith("~/")) path = join(home, path.slice(2));
	else if (path.startsWith("file://")) path = fileURLToPath(path);
	return isAbsolute(path) ? resolve(path) : resolve(cwd, path);
}

/**
 * Follow every link on the path. A file that does not exist yet resolves
 * through the links above it, and a dangling link resolves to its target,
 * because a write through that link creates the target.
 */
export function followLinks(path: string, depth = 0): string {
	try {
		return realpathSync(path);
	} catch {
		// The path or a part of it does not exist. Continue by hand.
	}
	if (depth > 40) return path;
	try {
		const target = readlinkSync(path);
		return followLinks(resolve(dirname(path), target), depth + 1);
	} catch {
		// Not a link.
	}
	const parent = dirname(path);
	if (parent === path) return path;
	return join(followLinks(parent, depth + 1), basename(path));
}

export function isInside(path: string, dir: string): boolean {
	return path === dir || path.startsWith(dir === sep ? dir : dir + sep);
}

/**
 * The directories a session may read without asking: the current directory,
 * unless it is too wide. A pi started in `~` has no roots, so that a read of
 * `~/.config/gh/hosts.yml` does not pass without a check.
 */
export function sessionRoots(cwd: string, home: string, tmp = tmpdir()): string[] {
	const real = followLinks(cwd);
	const realHome = followLinks(home);
	const tooWide = isInside(realHome, real) || real === followLinks(tmp) || real === followLinks("/tmp");
	return tooWide ? [] : [real];
}

/** True when the path exists and is inside a root, after following links. */
export function isInRoots(path: string, roots: readonly string[]): boolean {
	let real: string;
	try {
		real = realpathSync(path);
	} catch {
		return false;
	}
	return roots.some((root) => isInside(real, root));
}
