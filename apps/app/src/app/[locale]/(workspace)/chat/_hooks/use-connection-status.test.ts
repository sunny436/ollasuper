import { expect, test } from "bun:test";
import { type SocketMemory, nextStatus } from "./use-connection-status";

test("offline wins over everything", () => {
  const m: SocketMemory = { everConnected: true, downSince: null };
  expect(nextStatus(false, true, 0, m)).toBe("offline");
});

test("the first connect on page load never announces a problem", () => {
  const m: SocketMemory = { everConnected: false, downSince: null };
  expect(nextStatus(true, false, 0, m)).toBe("online");
  expect(nextStatus(true, false, 10_000, m)).toBe("online");
  expect(nextStatus(true, true, 11_000, m)).toBe("online");
  expect(m.everConnected).toBe(true);
});

test("a drop is announced only after the grace period, and clears on reconnect", () => {
  const m: SocketMemory = { everConnected: true, downSince: null };
  expect(nextStatus(true, false, 1_000, m)).toBe("online");
  expect(nextStatus(true, false, 2_500, m)).toBe("online");
  expect(nextStatus(true, false, 3_000, m)).toBe("reconnecting");
  expect(nextStatus(true, true, 4_000, m)).toBe("online");
  expect(m.downSince).toBeNull();
  expect(nextStatus(true, false, 5_000, m)).toBe("online");
});
