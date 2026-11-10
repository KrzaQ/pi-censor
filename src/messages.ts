// The user's typed messages that the classifier sees: the first few, which
// usually set the task, and the last several, which show where the work is now.

import type { UserMessageLimits } from "./config.ts";

export interface UserMessageView {
	first: string[];
	/** How many messages between `first` and `last` the classifier does not see. */
	leftOut: number;
	last: string[];
}

/**
 * Shorten a message to at most `chars` characters, and keep both ends. The
 * request is often at the end: pasted text or an earlier conversation comes
 * first. A quarter of the space goes to the start.
 */
export function clip(text: string, chars: number): string {
	if (text.length <= chars) return text;
	const marker = (count: number) => `\n[… ${count} characters left out …]\n`;
	const head = Math.floor(chars / 4);
	// The full length has at least as many digits as the count, so the
	// result never grows past `chars`.
	const tail = Math.max(0, chars - head - marker(text.length).length);
	return text.slice(0, head) + marker(text.length - head - tail) + text.slice(text.length - tail);
}

export class UserMessages {
	private readonly first: string[] = [];
	private readonly last: string[] = [];
	private leftOut = 0;

	constructor(private readonly limits: UserMessageLimits) {}

	add(text: string): void {
		const clipped = clip(text, this.limits.chars);
		if (this.first.length < this.limits.first) {
			this.first.push(clipped);
			return;
		}
		this.last.push(clipped);
		if (this.last.length > this.limits.last) {
			this.last.shift();
			this.leftOut++;
		}
	}

	view(): UserMessageView {
		return { first: [...this.first], leftOut: this.leftOut, last: [...this.last] };
	}
}
