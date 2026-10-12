import { expect, it } from "vitest";
import { createSessionValidator } from "../../functions/_lib/auth/session";

it("ignores a forged user header and rolls the verified session by 90 days", async () => {
  const now = Date.UTC(2026, 9, 11);
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const validate = createSessionValidator({
    now: () => now,
    random: () => "a".repeat(64),
    hash: async () => "b".repeat(64),
    fetch: async () => { throw new Error("network forbidden"); },
    rpc: async (name, args) => {
      calls.push({ name, args });
      return { user_uuid: "11111111-1111-4111-8111-111111111111", email: "test@example.invalid" };
    },
  });
  const identity = await validate(new Request("https://radio.test/api/session", {
    headers: { Cookie: `__Host-pr-session=${"a".repeat(64)}`, "x-user-uuid": "forged" },
  }));
  expect(identity).toEqual({ userUuid: "11111111-1111-4111-8111-111111111111", sessionHash: "b".repeat(64) });
  expect(calls).toEqual([{ name: "web_session_roll", args: {
    p_session_hash: "b".repeat(64), p_now: new Date(now).toISOString(),
  } }]);
});
