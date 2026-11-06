import { createMessage } from "@deepseek-ai/dsh-llm";
import { toolCallId } from "./dsh-compat.mjs";

/** Continued native cards require the host's timed question schema. */
export function supportsAsyncQuestions(tools = []) {
  return tools.some(tool => tool.name === "ask_user_question"
    && Object.hasOwn(tool.parameters?.properties ?? {}, "timeout"));
}

export function isAsyncMessage(item) {
  return item?.type === "agentMessage" && item.delivery === "async";
}

export function isAsyncQuestion(item) {
  return isAsyncMessage(item) && item.questions?.length > 0;
}

/** Project Codex's already-issued async question into DSH's durable question protocol. */
export function appendAsyncQuestion(agent, threadId, turnId, item, location) {
  const callId = toolCallId(`relay-codex-question:${JSON.stringify([threadId, turnId, item.id])}`);
  const questions = item.questions.map((question, index) => ({
    id: `question-${index + 1}`,
    question: question.title,
    ...(question.options?.length ? { options: question.options.map(label => ({ label })) } : {}),
  }));
  const args = JSON.stringify({ questions });
  agent.session.append("assistant/message", {
    ...location, stream: [],
    message: createMessage({
      role: "assistant", source: { kind: "model", provider: "relay-codex", model: "codex" },
      content: [{ type: "tool-call", id: callId, name: "ask_user_question", arguments: args }],
    }),
  }, { surfaceOp: "append" });
  agent.session.append("tool/call", {
    ...location, callId, name: "ask_user_question", arguments: args,
  });
  // Codex has accepted the question and continues its turn. There is no RPC
  // waiting for an answer; the native service will steer a late human reply.
  agent.session.append("tool/result", {
    ...location,
    message: createMessage({
      role: "tool", toolCallId: callId, source: { kind: "tool", callId },
      content: [{ type: "text", text: JSON.stringify({ pending: true, callId }) }],
      isError: false,
    }),
  }, { surfaceOp: "append" });
}
