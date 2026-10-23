import assert from "node:assert/strict";
import test from "node:test";
import { Config } from "../host-plugin.js";

test("native plugin Config validates the persisted runtime command", () => {
  assert.equal(Config({}).codexCommand.get(), "");
  for (const codexCommand of ["auto", "bundled", "/test/codex"]) {
    assert.equal(Config({ codexCommand }).codexCommand.get(), codexCommand);
  }
  assert.throws(() => Config({ codexCommand: 42 }));
});
