import assert from "node:assert/strict";
import test from "node:test";
import { validateLoopbackReturnUri } from "../src/services/oauth-session-service.js";

test("OAuth return URI accepts only numeric loopback callback ports", () => {
  assert.equal(validateLoopbackReturnUri("http://127.0.0.1:1024/callback"), "http://127.0.0.1:1024/callback");
  assert.equal(validateLoopbackReturnUri("http://[::1]:65535/callback"), "http://[::1]:65535/callback");
  for (const invalid of [
    "http://localhost:3000/callback",
    "https://127.0.0.1:3000/callback",
    "http://127.0.0.1:1023/callback",
    "http://127.0.0.1:3000/other",
    "http://127.0.0.1:3000/callback?code=x",
    "http://user@127.0.0.1:3000/callback",
  ]) {
    assert.throws(() => validateLoopbackReturnUri(invalid), { code: "invalid_return_uri" });
  }
});

test("OAuth return URI accepts a high-entropy callback path binding", () => {
  const suffix = "a".repeat(43);
  assert.equal(validateLoopbackReturnUri(`http://127.0.0.1:49152/callback/${suffix}`), `http://127.0.0.1:49152/callback/${suffix}`);
  assert.throws(() => validateLoopbackReturnUri("http://127.0.0.1:49152/callback/short"));
});
