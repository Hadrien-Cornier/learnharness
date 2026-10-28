import type { AgentMessage, AgentOptions, BeforeToolCallContext } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { QUESTION_TOOLS } from "../core/pending.ts";
import { SEND_TO_USER_TOOL, sendToUserText } from "../core/native-messages.ts";

const failedGeneration = (message: AssistantMessage) =>
	["error", "aborted", "length"].includes(message.stopReason);

/** A check must follow delivered teaching in the current learner step.
 * Thinking and question arguments are not delivered teaching. */
export function teachingCheckGuard(): Pick<AgentOptions, "beforeToolCall" | "afterToolCall"> {
	// Pi appends a batch's results to context only after the batch ends.
	// Track successful output in the same batch without accepting future calls.
	const delivered = new WeakMap<AssistantMessage, Set<string>>();
	function hasTeaching({ assistantMessage, toolCall, context }: BeforeToolCallContext): boolean {
		const messages = context.messages;
		let start = 0;
		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i]!;
			if (message.role === "user" || (message.role === "toolResult" && !message.isError &&
				(QUESTION_TOOLS as readonly string[]).includes(message.toolName))) {
				start = i + 1;
				break;
			}
		}
		for (let i = start; i < messages.length; i++) {
			const message = messages[i]!;
			if (message.role !== "assistant" || failedGeneration(message)) continue;
			for (const block of message.content) {
				if (message === assistantMessage && block.type === "toolCall" && block.id === toolCall.id) return false;
				if (block.type === "text" && block.text.trim()) return true;
				if (sendToUserText(block) === undefined || block.type !== "toolCall") continue;
				const success = delivered.get(message)?.has(block.id) || messages.slice(i + 1).some((result: AgentMessage) =>
					result.role === "toolResult" && result.toolCallId === block.id &&
					result.toolName === SEND_TO_USER_TOOL && !result.isError);
				if (success) return true;
			}
		}
		return false;
	}
	return {
		beforeToolCall: async (call) => {
			if (!["quiz", "explain"].includes(call.toolCall.name) ||
				(call.args as { type?: unknown }).type !== "check" || hasTeaching(call)) return undefined;
			return {
				block: true,
				reason: "This check has no visible teaching before it. Thinking is not visible teaching. " +
					"Write the explanation for this step first, then issue the check again. " +
					"If send_to_user is available, deliver the explanation through that tool before the check.",
			};
		},
		afterToolCall: async ({ assistantMessage, toolCall, isError }) => {
			if (toolCall.name === SEND_TO_USER_TOOL && !isError && !failedGeneration(assistantMessage)) {
				let calls = delivered.get(assistantMessage);
				if (!calls) delivered.set(assistantMessage, calls = new Set());
				calls.add(toolCall.id);
			}
			return undefined;
		},
	};
}
