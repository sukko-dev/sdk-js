import { describe, expect, it, vi } from "vitest";
import { TypedEventEmitter } from "../src/emitter";

type TestEvents = {
	message: (data: string) => void;
	count: (n: number) => void;
	multi: (a: string, b: number) => void;
};

class TestEmitter extends TypedEventEmitter<TestEvents> {
	public doEmit<K extends keyof TestEvents>(event: K, ...args: Parameters<TestEvents[K]>): void {
		this.emit(event, ...args);
	}
}

describe("TypedEventEmitter", () => {
	it("calls handler on emit", () => {
		const emitter = new TestEmitter();
		const handler = vi.fn();

		emitter.on("message", handler);
		emitter.doEmit("message", "hello");

		expect(handler).toHaveBeenCalledWith("hello");
	});

	it("supports multiple listeners per event", () => {
		const emitter = new TestEmitter();
		const handler1 = vi.fn();
		const handler2 = vi.fn();

		emitter.on("message", handler1);
		emitter.on("message", handler2);
		emitter.doEmit("message", "test");

		expect(handler1).toHaveBeenCalledWith("test");
		expect(handler2).toHaveBeenCalledWith("test");
	});

	it("returns unsubscribe function from on()", () => {
		const emitter = new TestEmitter();
		const handler = vi.fn();

		const off = emitter.on("message", handler);
		emitter.doEmit("message", "before");
		expect(handler).toHaveBeenCalledTimes(1);

		off();
		emitter.doEmit("message", "after");
		expect(handler).toHaveBeenCalledTimes(1);
	});

	it("removes specific listener with off()", () => {
		const emitter = new TestEmitter();
		const handler1 = vi.fn();
		const handler2 = vi.fn();

		emitter.on("message", handler1);
		emitter.on("message", handler2);
		emitter.off("message", handler1);
		emitter.doEmit("message", "test");

		expect(handler1).not.toHaveBeenCalled();
		expect(handler2).toHaveBeenCalledWith("test");
	});

	it("removeAllListeners for specific event", () => {
		const emitter = new TestEmitter();
		const msgHandler = vi.fn();
		const countHandler = vi.fn();

		emitter.on("message", msgHandler);
		emitter.on("count", countHandler);
		emitter.removeAllListeners("message");

		emitter.doEmit("message", "test");
		emitter.doEmit("count", 42);

		expect(msgHandler).not.toHaveBeenCalled();
		expect(countHandler).toHaveBeenCalledWith(42);
	});

	it("removeAllListeners clears everything", () => {
		const emitter = new TestEmitter();
		const handler1 = vi.fn();
		const handler2 = vi.fn();

		emitter.on("message", handler1);
		emitter.on("count", handler2);
		emitter.removeAllListeners();

		emitter.doEmit("message", "test");
		emitter.doEmit("count", 42);

		expect(handler1).not.toHaveBeenCalled();
		expect(handler2).not.toHaveBeenCalled();
	});

	it("listenerCount returns correct count", () => {
		const emitter = new TestEmitter();
		expect(emitter.listenerCount("message")).toBe(0);

		const off = emitter.on("message", vi.fn());
		emitter.on("message", vi.fn());
		expect(emitter.listenerCount("message")).toBe(2);

		off();
		expect(emitter.listenerCount("message")).toBe(1);
	});

	it("emitting event with no listeners is a no-op", () => {
		const emitter = new TestEmitter();
		expect(() => emitter.doEmit("message", "test")).not.toThrow();
	});

	it("supports multi-argument events", () => {
		const emitter = new TestEmitter();
		const handler = vi.fn();

		emitter.on("multi", handler);
		emitter.doEmit("multi", "hello", 42);

		expect(handler).toHaveBeenCalledWith("hello", 42);
	});
});
