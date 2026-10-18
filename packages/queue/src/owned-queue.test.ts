import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({ close: vi.fn(), disconnect: vi.fn() }));
vi.mock("bullmq", () => ({
  Queue: class {
    async close() {
      await mocks.close();
    }
  },
}));
vi.mock("ioredis", () => ({
  Redis: class {
    disconnect(reconnect: boolean) {
      mocks.disconnect(reconnect);
    }
  },
}));
import { createEvaluationQueue } from "./index.js";

describe("owned producer lifecycle", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });
  it("closes BullMQ before disconnecting its owned Redis connection", async () => {
    mocks.close.mockImplementation(() => {
      expect(mocks.disconnect).not.toHaveBeenCalled();
    });
    await createEvaluationQueue("redis://127.0.0.1:6379/15").close();
    expect(mocks.disconnect).toHaveBeenCalledExactlyOnceWith(false);
  });
  it("disconnects even when BullMQ close fails and preserves that failure", async () => {
    mocks.close.mockRejectedValue(new Error("close failed"));
    await expect(createEvaluationQueue("redis://127.0.0.1:6379/15").close()).rejects.toThrow(
      "close failed",
    );
    expect(mocks.disconnect).toHaveBeenCalledExactlyOnceWith(false);
  });
});
