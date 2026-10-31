import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Protection } from "../src/rules.ts";

export interface Sandbox {
	base: string;
	cwd: string;
	protection: Protection;
}

/** A fake home with a project in it. Nothing touches the real home. */
export function sandbox(): Sandbox {
	const base = realpathSync(mkdtempSync(join(tmpdir(), "pi-censor-test-")));
	const home = join(base, "home");
	const cwd = join(home, "project");
	mkdirSync(join(cwd, "src"), { recursive: true });
	const protection: Protection = {
		home,
		agentDir: join(home, ".pi", "agent"),
		ownDir: join(home, "tools", "pi-censor"),
		configDir: join(home, ".config", "pi-censor"),
		logDir: join(home, ".local", "state", "pi-censor"),
	};
	mkdirSync(protection.agentDir, { recursive: true });
	mkdirSync(protection.ownDir, { recursive: true });
	return { base, cwd, protection };
}
