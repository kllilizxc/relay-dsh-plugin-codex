const verbs = {
  read: ["Reading", "Read", "read", "File read"],
  search: ["Searching", "Searched", "search", "Search"],
  listFiles: ["Listing", "Listed", "list", "File listing"],
  command: ["Running", "Ran", "run", "Command"],
  edit: ["Editing", "Edited", "edit", "File edit"],
  image: ["Viewing", "Viewed", "view", "Image view"],
  imageGeneration: ["Generating", "Generated", "generate", "Image generation"],
  webSearch: ["Searching", "Searched", "search", "Web search"],
  tool: ["Using", "Used", "use", "Tool use"],
  plan: ["Updating", "Updated", "update", "Plan update"],
};

export function describeActivity(activity) {
  const parts = activityParts(activity);
  const categories = new Set(parts.map(part => part.category));
  return {
    title: parts.length === 1 ? partTitle(parts[0]) : summarizeParts(parts),
    category: categories.size === 1 ? parts[0].category : "command",
  };
}

// Pass each activity's latest snapshot once; this helper does not deduplicate events.
export function summarizeActivities(activities) {
  return summarizeParts(Array.from(activities, activityParts).flat());
}

function activityParts(activity) {
  const value = activity ?? {};
  const state = activityState(value);
  if (value.type === "commandExecution") {
    const command = commandText(value);
    const actions = commandParts(value.commandActions, command);
    return actions.map(action => ({ ...action, ...state }));
  }
  const known = {
    fileChange: { category: "edit", subject: value.title === "Edited files" ? "files" : "a file" },
    imageView: { category: "image", subject: "an image" },
    imageGeneration: { category: "imageGeneration", subject: "an image" },
    webSearch: { category: "webSearch", subject: text(value.summary) ? `the web for ${quoted(value.summary)}` : "the web" },
    mcpToolCall: { category: "tool", subject: "a tool", label: value.title === "Used a tool" ? "" : short(value.title, 120) },
    plan: { category: "plan", subject: "the plan" },
  };
  const part = Object.hasOwn(known, value.type) ? known[value.type] : {
    category: "unknown",
    label: short(value.title, 120) || short(humanize(value.type), 120) || "Unknown activity",
  };
  return [{ ...part, ...state }];
}

function activityState(activity) {
  if (activity.status === "running" || activity.status === "error") return { state: activity.status };
  if (activity.status !== "completed") return { state: "unknown" };
  const code = activity.exitCode;
  const numeric = typeof code === "number" ? code
    : typeof code === "string" && /^-?\d+$/.test(code.trim()) ? Number(code) : NaN;
  if (activity.type === "commandExecution" && Number.isSafeInteger(numeric) && numeric !== 0) {
    return { state: "exited", exitCode: numeric };
  }
  return { state: "completed" };
}

function commandParts(metadata, command) {
  let actions = metadata;
  if (typeof actions === "string") {
    if (!actions.trim()) return simpleCommand(command);
    try { actions = JSON.parse(actions); }
    catch { return [structuredAction(null, command)]; }
    // Truncated or invalid wire metadata must not imply a more specific action.
    if (!Array.isArray(actions)) return [structuredAction(null, command)];
  }
  if (actions == null || (Array.isArray(actions) && actions.length === 0)) return simpleCommand(command);
  return Array.isArray(actions)
    ? Array.from(actions, action => structuredAction(action, command))
    : [structuredAction(null, command)];
}

function structuredAction(action, fallback) {
  if (action?.type === "read") {
    const path = text(action.path);
    const name = text(action.name) || basename(path);
    return { category: "read", subject: name || "files", target: path || name };
  }
  if (action?.type === "search") {
    const query = text(action.query);
    const path = text(action.path);
    return { category: "search", subject: `${query ? `for ${quoted(query)}` : "files"}${path ? ` in ${short(path)}` : ""}` };
  }
  if (action?.type === "listFiles") {
    const path = text(action.path);
    return { category: "listFiles", subject: `files${path ? ` in ${short(path)}` : ""}` };
  }
  // Unknown/future actions stay visible and never borrow a classification from raw shell text.
  return { category: "command", subject: short(text(action?.cmd) || fallback) || "a command" };
}

function commandText(activity) {
  const input = text(activity.input);
  return input ? input.replace(/^\$ /, "") : text(activity.summary);
}

function simpleCommand(command) {
  const fallback = [{ category: "command", subject: short(command) || "a command" }];
  // This is deliberately only a literal, unquoted subset, not a shell parser.
  // Wrappers, expansions, operators, redirections and unknown flags stay generic.
  if (!command || !/^[A-Za-z0-9_./:@%+=, \t-]+$/.test(command)) return fallback;
  const [executable, ...args] = command.trim().split(/[ \t]+/);
  if (args.some(arg => arg.startsWith("="))) return fallback;
  const name = basename(executable);
  if (executable !== name && !["/bin/", "/usr/bin/", "/usr/local/bin/", "/opt/homebrew/bin/"]
    .some(prefix => executable === `${prefix}${name}`)) return fallback;
  let paths;
  if (name === "cat") {
    paths = operands(args, /^-[nbsvET]+$/);
  } else if (name === "head" || name === "tail") {
    let rest = args;
    if (rest[0] === "-n" || rest[0] === "-c") {
      if (!/^\d+$/.test(rest[1] ?? "")) return fallback;
      rest = rest.slice(2);
    } else if (/^-\d+$/.test(rest[0] ?? "")) rest = rest.slice(1);
    paths = operands(rest, /^-[qv]+$/);
  } else if (name === "sed" && args[0] === "-n" && /^\d+(,\d+)?p$/.test(args[1] ?? "")) {
    paths = operands(args.slice(2));
  } else if (name === "ls") {
    paths = operands(args, /^-[alAh1dFRtSr]+$/);
    return paths ? [listing(paths)] : fallback;
  } else if (name === "rg" && args[0] === "--files") {
    paths = operands(args.slice(1), /^(--hidden|--no-ignore)$/);
    return paths ? [listing(paths)] : fallback;
  } else if (name === "find" && args.length === 3 && args[1] === "-type" && /^[fd]$/.test(args[2])) {
    return args[0].startsWith("-") ? fallback : [listing([args[0]])];
  } else if (name === "rg" || name === "grep") {
    const rest = operands(args, /^-[nilwsvxF]+$/);
    if (!rest?.length || (name === "grep" && rest.length < 2)) return fallback;
    return [structuredAction({ type: "search", query: rest[0], path: rest.slice(1).join(", ") }, command)];
  }
  return paths?.length && paths.every(path => !path.endsWith("/") && ![".", ".."].includes(basename(path)))
    ? paths.map(path => ({ category: "read", subject: basename(path), target: path })) : fallback;
}

function operands(args, flags = /$a/) {
  const paths = [];
  let literal = false;
  for (const arg of args) {
    if (!literal && arg === "--") { literal = true; continue; }
    if (!literal && flags.test(arg)) continue;
    if (!literal && arg.startsWith("-")) return null;
    if (arg === "-") return null;
    paths.push(arg);
  }
  return paths;
}

function listing(paths) {
  return { category: "listFiles", subject: `files${paths.length ? ` in ${short(paths.join(", "))}` : ""}` };
}

function summarizeParts(parts) {
  const groups = new Map();
  for (const part of parts) {
    const key = JSON.stringify([part.category, part.state, part.exitCode, part.category === "unknown" ? part.label : null]);
    const group = groups.get(key) ?? [];
    group.push(part);
    groups.set(key, group);
  }
  return [...groups.values()].map((group, index) => {
    const first = group[0];
    const title = partTitle({ ...first, label: first.category === "unknown" ? first.label : undefined,
      subject: groupSubject(group), count: group.length });
    return index > 0 && first.category !== "unknown" ? title[0].toLowerCase() + title.slice(1) : title;
  }).join(", ");
}

function groupSubject(group) {
  const part = group[0];
  const count = group.length;
  switch (part.category) {
    case "read": return group.some(item => !item.target) || new Set(group.map(item => item.target)).size > 1 ? "files" : "a file";
    case "search": case "listFiles": return "files";
    case "command": return count === 1 ? "a command" : "commands";
    case "edit": return count === 1 && part.subject === "a file" ? "a file" : "files";
    case "image": case "imageGeneration": return count === 1 ? "an image" : `${count} images`;
    case "webSearch": return "the web";
    case "tool": return count === 1 ? "a tool" : "tools";
    case "plan": return "the plan";
    default: return "";
  }
}

function partTitle(part) {
  if (part.label) {
    const suffix = { running: " (running)", error: " (failed)", unknown: " (status unknown)" }[part.state] ?? "";
    return `${short(part.label, 120)}${part.count > 1 ? ` (${part.count} activities)` : ""}${suffix}`;
  }
  const [present, past, infinitive, neutral] = verbs[part.category];
  const subject = short(part.subject);
  if (part.state === "running") return `${present} ${subject}`;
  if (part.state === "completed") return `${past} ${subject}`;
  if (part.state === "error") return `Failed to ${infinitive} ${subject}`;
  if (part.state === "exited") return `${neutral} exited ${part.exitCode}: ${subject}`;
  return `${neutral} (status unknown): ${subject}`;
}

function basename(path) {
  return path.replace(/\\/g, "/").split("/").filter(Boolean).at(-1) ?? "";
}

function humanize(value) {
  const label = text(value).replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ");
  return label ? label[0].toUpperCase() + label.slice(1) : "";
}

function quoted(value) {
  return JSON.stringify(short(value, 60));
}

function short(value, limit = 80) {
  const chars = Array.from(text(value).replace(/[\x00-\x1f\x7f\s]+/g, " ").trim());
  return chars.length > limit ? chars.slice(0, limit - 3).join("") + "..." : chars.join("");
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}
