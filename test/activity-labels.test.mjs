import assert from "node:assert/strict";
import test from "node:test";

import { describeActivity, summarizeActivities } from "../codex-activity-labels.mjs";

function command(input, extra = {}) {
  return { type: "commandExecution", status: "completed", title: "Ran commands", input, ...extra };
}

function action(type, metadata = {}, extra = {}) {
  return command("npm test", { commandActions: [{ type, ...metadata }], ...extra });
}

test("structured reads take priority over raw commands and stale wire titles", () => {
  const activity = action("read", { cmd: "cat README.md", name: "README.md", path: "/repo/README.md" });
  assert.deepEqual(describeActivity({ ...activity, status: "running" }), { title: "Reading README.md", category: "read" });
  assert.deepEqual(describeActivity(activity), { title: "Read README.md", category: "read" });
  assert.equal(describeActivity(action("read", { path: "/repo/docs/README.md" })).title, "Read README.md");
  assert.equal(describeActivity(action("read", { path: "C:\\repo\\README.md" })).title, "Read README.md");
  assert.equal(describeActivity(action("read")).title, "Read files");
});

test("structured searches and listings preserve available query and path details", () => {
  const search = action("search", { query: "TODO", path: "src" });
  assert.deepEqual(describeActivity({ ...search, status: "running" }), { title: 'Searching for "TODO" in src', category: "search" });
  assert.equal(describeActivity(search).title, 'Searched for "TODO" in src');
  assert.equal(describeActivity(action("search", { query: null, path: null })).title, "Searched files");
  assert.equal(describeActivity(action("search", { path: "docs" })).title, "Searched files in docs");
  const listing = action("listFiles", { path: "/repo" });
  assert.deepEqual(describeActivity({ ...listing, status: "running" }), { title: "Listing files in /repo", category: "listFiles" });
  assert.equal(describeActivity(listing).title, "Listed files in /repo");
  assert.equal(describeActivity(action("listFiles")).title, "Listed files");
});

test("unknown and malformed structured actions remain commands instead of being reinterpreted", () => {
  for (const metadata of [{ type: "unknown" }, { type: "futureAction" }, {}, null, "read", 2]) {
    const activity = command("cat README.md", { commandActions: [metadata] });
    assert.deepEqual(describeActivity(activity), { title: "Ran cat README.md", category: "command" });
  }
  assert.equal(describeActivity(action("unknown", { cmd: "npm test" })).title, "Ran npm test");
  for (const commandActions of [undefined, null, [], "", "   ", "[]"]) {
    assert.equal(describeActivity(command("cat README.md", { commandActions })).title, "Read README.md");
  }
});

test("host-bounded JSON strings and parsed actions produce the same labels and summaries", () => {
  for (const commandActions of [
    [{ type: "read", cmd: "cat README.md", path: "/repo/README.md", name: "README.md" }],
    [{ type: "search", cmd: "rg TODO src", query: "TODO", path: "src" }],
    [{ type: "listFiles", cmd: "ls src", path: "src" }],
    [{ type: "unknown", cmd: "npm test" }],
    [{ type: "read", name: "README.md" }, { type: "unknown", cmd: "npm test" }],
  ]) {
    for (const status of ["running", "completed", "error"]) {
      const parsed = command("/bin/zsh -lc 'npm test'", { commandActions, status });
      const wire = { ...parsed, commandActions: JSON.stringify(commandActions, null, 2) };
      assert.deepEqual(describeActivity(wire), describeActivity(parsed));
      assert.equal(summarizeActivities([wire]), summarizeActivities([parsed]));
    }
  }
  assert.deepEqual(describeActivity(command("npm test", {
    status: "running", commandActions: '[{"type":"read","name":"README.md"}]',
  })), { title: "Reading README.md", category: "read" });
});

test("malformed, truncated and non-array metadata is not partially interpreted", () => {
  for (const commandActions of [
    "read", {}, 42, '[{"type":"read"}', '[{"type":"read"}] trailing',
    '[{"type":"read"},]', '[{"type":"read","path":"README.md"}\n...',
    '{"type":"read"}', '"read"', "null", "42", "true", '[null]',
    "```json\n[]\n```", "[{type:'read'}]",
  ]) {
    assert.deepEqual(describeActivity(command("cat README.md", { commandActions })),
      { title: "Ran cat README.md", category: "command" }, String(commandActions));
  }
  assert.equal(describeActivity(command("cat README.md", { commandActions: new Array(1) })).category, "command");
});

test("mixed actions retain every category and use command as the row's category", () => {
  const mixed = command("cat a; npm test", { commandActions: [
    { type: "read", path: "/repo/a" }, { type: "read", path: "/repo/b" },
    { type: "unknown", cmd: "npm test" }, { type: "unknown", cmd: "npm run build" },
  ] });
  assert.deepEqual(describeActivity(mixed), { title: "Read files, ran commands", category: "command" });
  assert.equal(summarizeActivities([mixed]), "Read files, ran commands");
  assert.equal(describeActivity({ ...mixed, status: "running" }).title, "Reading files, running commands");
  assert.equal(describeActivity({ ...mixed, status: "error" }).title, "Failed to read files, failed to run commands");
});

test("simple literal read commands and common executable paths are recognized", () => {
  for (const input of ["cat README.md", "$ cat README.md", "/bin/cat README.md", "/usr/bin/cat -n README.md",
    "head -n 20 README.md", "tail -c 80 README.md", "head -10 README.md", "sed -n 1,20p README.md",
    "cat -- README.md", "cat\tREADME.md"]) {
    assert.deepEqual(describeActivity(command(input)), { title: "Read README.md", category: "read" }, input);
  }
  assert.equal(describeActivity(command("cat README.md LICENSE")).title, "Read files");
  assert.equal(describeActivity(command("cat README.md README.md")).title, "Read a file");
  assert.equal(describeActivity(command("cat -- -notes")).title, "Read -notes");
});

test("simple literal searches and file listings are recognized", () => {
  for (const input of ["rg -n TODO src", "/opt/homebrew/bin/rg -n TODO src", "grep -n TODO src"]) {
    assert.deepEqual(describeActivity(command(input)), { title: 'Searched for "TODO" in src', category: "search" }, input);
  }
  assert.equal(describeActivity(command("rg TODO")).title, 'Searched for "TODO"');
  assert.equal(describeActivity(command("rg --files")).title, "Listed files");
  assert.equal(describeActivity(command("rg --files --hidden src")).title, "Listed files in src");
  assert.equal(describeActivity(command("ls")).title, "Listed files");
  assert.equal(describeActivity(command("ls -la src")).title, "Listed files in src");
  assert.equal(describeActivity(command("find . -type f")).title, "Listed files in .");
});

test("shell wrappers, quoting, substitutions, pipelines and complex syntax stay generic", () => {
  const inputs = [
    "/bin/zsh -lc 'cat README.md'", '/bin/zsh -lc "cat README.md"', "bash -c cat README.md", "env cat README.md",
    "cat 'my file.md'", 'cat "README.md"', "sed -n '1,20p' README.md", "cat my\\ file.md",
    "cat $(touch /tmp/not-executed)", "cat `touch /tmp/not-executed`", "cat $HOME/README.md",
    "cat README.md && npm test", "cat README.md; npm test", "cat README.md\nnpm test",
    "cat README.md | head", "cat README.md > result.txt", "cat < README.md", "cat *.md", "cat ~/README.md",
    "cat README.md # comment", "cat {README,LICENSE}", "cat README.md &", "cat README.md\rwhoami",
    "cat README.md\u0000", "cat README.md\u001b[0m", "/tmp/cat README.md", "cat =ls",
  ];
  for (const input of inputs) {
    const description = describeActivity(command(input));
    assert.equal(description.category, "command", input);
    assert.match(description.title, /^Ran /, input);
    assert.doesNotMatch(description.title, /[\x00-\x1f\x7f]/, input);
  }
});

test("missing operands and unknown or mutating options cannot imply a read or listing", () => {
  for (const input of ["cat", "cat -", "cat --help", "head -n nope README.md", "tail -f README.md",
    "sed -i README.md", "sed -n 1,20p", "find . -delete", "ls --version", "rg -e TODO src",
    "rg --files --sort path", "grep TODO", "cat -x README.md", "head -n 20", "rg --files -",
    "cat /", "cat .", "cat ..", "cat docs/"]) {
    assert.equal(describeActivity(command(input)).category, "command", input);
  }
});

test("commands use full input before summary, with conservative short fallbacks", () => {
  assert.deepEqual(describeActivity(command("npm test", { status: "running" })), { title: "Running npm test", category: "command" });
  assert.equal(describeActivity(command("npm test")).title, "Ran npm test");
  assert.equal(describeActivity(command("npm test", { summary: "cat README.md" })).title, "Ran npm test");
  assert.equal(describeActivity(command("cat README.md\nnpm test", { summary: "cat README.md" })).category, "command");
  assert.equal(describeActivity(command(undefined, { summary: "cat README.md" })).title, "Read README.md");
  assert.equal(describeActivity(command("", { summary: "" })).title, "Ran a command");
  const long = describeActivity(command(`npm test ${"a".repeat(200)}`)).title;
  assert.equal(long.length, 84);
  assert.ok(long.endsWith("..."));
});

test("explicit errors and nonzero exits do not claim successful work", () => {
  assert.equal(describeActivity(action("read", { name: "README.md" }, { status: "error" })).title, "Failed to read README.md");
  assert.equal(describeActivity(command("npm test", { status: "error", exitCode: "0" })).title, "Failed to run npm test");
  for (const exitCode of [1, "1", " 1 "]) {
    assert.equal(describeActivity(action("search", { query: "TODO" }, { exitCode })).title, 'Search exited 1: for "TODO"');
  }
  assert.equal(describeActivity(command("npm test", { exitCode: "2" })).title, "Command exited 2: npm test");
  assert.equal(describeActivity(command("npm test", { status: "running", exitCode: 2 })).title, "Running npm test");
  for (const exitCode of [undefined, null, 0, "0", "", "oops", "NaN", Infinity, {}, true]) {
    assert.equal(describeActivity(command("npm test", { exitCode })).title, "Ran npm test");
  }
  assert.equal(describeActivity(command("npm test", { output: "error: fake message", exitCode: 0 })).title, "Ran npm test");
});

test("missing and unrecognized statuses never infer completion from an exit code", () => {
  for (const status of [undefined, null, "cancelled", "pending", "futureState"]) {
    assert.equal(describeActivity(command("npm test", { status, exitCode: 0 })).title, "Command (status unknown): npm test");
  }
});

test("known non-command activities use truthful tenses", () => {
  for (const [type, category, running, completed, error] of [
    ["fileChange", "edit", "Editing a file", "Edited a file", "Failed to edit a file"],
    ["imageView", "image", "Viewing an image", "Viewed an image", "Failed to view an image"],
    ["imageGeneration", "imageGeneration", "Generating an image", "Generated an image", "Failed to generate an image"],
    ["webSearch", "webSearch", "Searching the web", "Searched the web", "Failed to search the web"],
    ["plan", "plan", "Updating the plan", "Updated the plan", "Failed to update the plan"],
    ["mcpToolCall", "tool", "Using a tool", "Used a tool", "Failed to use a tool"],
  ]) {
    for (const [status, title] of Object.entries({ running, completed, error })) {
      assert.deepEqual(describeActivity({ type, status }), { category, title });
    }
  }
  assert.equal(describeActivity({ type: "fileChange", status: "running", title: "Edited files" }).title, "Editing files");
  assert.equal(describeActivity({ type: "webSearch", status: "completed", summary: "local docs" }).title, 'Searched the web for "local docs"');
  assert.equal(describeActivity({ type: "mcpToolCall", status: "running", title: "Fetch records" }).title, "Fetch records (running)");
  assert.equal(describeActivity({ type: "mcpToolCall", status: "running", title: "Used a tool" }).title, "Using a tool");
});

test("group summaries count images and preserve singular and plural file edits", () => {
  const image = { type: "imageView", status: "completed" };
  const edit = { type: "fileChange", status: "completed", title: "Edited a file" };
  assert.equal(summarizeActivities([image, image]), "Viewed 2 images");
  assert.equal(summarizeActivities([edit, command("npm test")]), "Edited a file, ran a command");
  assert.equal(summarizeActivities([edit, edit]), "Edited files");
  assert.equal(summarizeActivities([{ ...edit, title: "Edited files" }]), "Edited files");
  assert.equal(summarizeActivities([image, { ...image, type: "imageGeneration" }]), "Viewed an image, generated an image");
  assert.equal(summarizeActivities([command("cat a b"), command("npm test"), command("npm run build")]), "Read files, ran commands");
  assert.equal(summarizeActivities([command("cat a"), command("cat a")]), "Read a file");
  assert.equal(summarizeActivities([action("read")]), "Read files");
});

test("groups preserve first-seen ordering and separate live, failed and exited work", () => {
  assert.equal(summarizeActivities([
    command("npm test", { status: "running" }), action("read", { path: "a" }),
    command("npm run build", { status: "error" }), command("npm test", { exitCode: 2 }),
    command("npm test", { exitCode: 1 }), command("npm test"),
  ]), "Running a command, read a file, failed to run a command, command exited 2: a command, command exited 1: a command, ran a command");
  assert.equal(summarizeActivities([action("search"), action("listFiles"), { type: "plan", status: "running" }]),
    "Searched files, listed files, updating the plan");
  assert.equal(summarizeActivities([{ type: "imageView", status: "error" }, { type: "imageView", status: "completed" }]),
    "Failed to view an image, viewed an image");
});

test("unknown activities and custom tool names remain visible without inventing semantics", () => {
  const unknown = { type: "futureWidget", status: "completed", title: "Inspect README.md" };
  assert.deepEqual(describeActivity(unknown), { category: "unknown", title: "Inspect README.md" });
  assert.equal(describeActivity({ type: "futureWidget", status: "running" }).title, "Future Widget (running)");
  assert.equal(describeActivity({ ...unknown, status: "error" }).title, "Inspect README.md (failed)");
  assert.equal(summarizeActivities([command("npm test"), unknown]), "Ran a command, Inspect README.md");
  assert.equal(summarizeActivities([unknown, unknown]), "Inspect README.md (2 activities)");
  assert.equal(describeActivity({ type: "toString", status: "completed" }).category, "unknown");
  assert.equal(describeActivity(null).title, "Unknown activity (status unknown)");
  assert.equal(describeActivity({ type: "", status: "completed", title: "\u0000" }).title, "Unknown activity");
  assert.equal(describeActivity({ type: "mcpToolCall", status: "error", title: "Fetch records" }).title, "Fetch records (failed)");
});

test("helpers are deterministic, do not mutate input, and ignore transcript output", () => {
  const activity = Object.freeze(action("read", { name: "README.md" }, { output: "Viewed 200 images" }));
  Object.freeze(activity.commandActions[0]);
  Object.freeze(activity.commandActions);
  const activities = Object.freeze([activity]);
  const before = JSON.stringify(activities);
  assert.equal(summarizeActivities(activities), "Read a file");
  assert.deepEqual(describeActivity(activity), describeActivity(activity));
  assert.equal(JSON.stringify(activities), before);
  assert.equal(summarizeActivities([]), "");
});
