import { describe, expect, test } from "bun:test";
import { clip, UserMessages } from "../src/messages.ts";

describe("clip", () => {
	test("a short message stays as it is", () => {
		expect(clip("hello", 2000)).toBe("hello");
		expect(clip("x".repeat(2000), 2000)).toHaveLength(2000);
	});

	test("a long message keeps its start and its end", () => {
		const text = `START ${"a".repeat(10_000)} the actual request END`;
		const clipped = clip(text, 2000);
		expect(clipped.length).toBeLessThanOrEqual(2000);
		expect(clipped.startsWith("START ")).toBe(true);
		expect(clipped.endsWith("the actual request END")).toBe(true);
	});

	test("the marker counts exactly what is left out", () => {
		for (const length of [2001, 2500, 9_999, 10_000, 123_456]) {
			const text = "x".repeat(length);
			const clipped = clip(text, 2000);
			const count = Number(clipped.match(/\[… (\d+) characters left out …\]/)?.[1]);
			const marker = clipped.match(/\n\[… \d+ characters left out …\]\n/)?.[0] ?? "";
			expect(clipped.length - marker.length + count).toBe(length);
			expect(clipped.length).toBeLessThanOrEqual(2000);
		}
	});

	test("a quarter of the space goes to the start", () => {
		const clipped = clip(`${"s".repeat(5000)}${"e".repeat(5000)}`, 2000);
		expect(clipped.indexOf("\n[…")).toBe(500);
	});
});

describe("UserMessages", () => {
	const limits = { first: 2, last: 3, chars: 2000 };

	test("keeps the first messages and the last ones, and counts the rest", () => {
		const messages = new UserMessages(limits);
		for (let i = 0; i < 9; i++) messages.add(`m${i}`);
		expect(messages.view()).toEqual({ first: ["m0", "m1"], leftOut: 4, last: ["m6", "m7", "m8"] });
	});

	test("leaves nothing out while everything fits", () => {
		const messages = new UserMessages(limits);
		for (let i = 0; i < 4; i++) messages.add(`m${i}`);
		expect(messages.view()).toEqual({ first: ["m0", "m1"], leftOut: 0, last: ["m2", "m3"] });
	});

	test("first can be zero", () => {
		const messages = new UserMessages({ ...limits, first: 0 });
		for (let i = 0; i < 5; i++) messages.add(`m${i}`);
		expect(messages.view()).toEqual({ first: [], leftOut: 2, last: ["m2", "m3", "m4"] });
	});

	test("clips each message", () => {
		const messages = new UserMessages({ ...limits, chars: 300 });
		messages.add(`${"x".repeat(5000)} please run the tests`);
		const [first] = messages.view().first;
		expect(first?.length).toBeLessThanOrEqual(300);
		expect(first?.endsWith("please run the tests")).toBe(true);
	});

	test("a view is a copy", () => {
		const messages = new UserMessages(limits);
		messages.add("a");
		messages.view().first.push("b");
		expect(messages.view().first).toEqual(["a"]);
	});
});
