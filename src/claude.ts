import type Anthropic from "@anthropic-ai/sdk";
import { checkRequest, type Model } from "./model.ts";
import { fromStructured, INSTRUCTIONS, PROPOSAL_SCHEMA, proposalInput } from "./structured.ts";

export const CLAUDE_DEFAULT_MODEL = "claude-opus-5-5";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];

export interface ClaudeOptions {
  client: Anthropic;
  model?: string;
  effort?: Effort;
}

export function claudeModel(o: ClaudeOptions): Model {
  const model = o.model ?? CLAUDE_DEFAULT_MODEL;
  return {
    name: `claude:${model}`,
    timed: true,
    async propose(request) {
      const checked = checkRequest(request);
      const response = await o.client.messages.create({
        model,
        max_tokens: 16000,
        system: INSTRUCTIONS,
        messages: [{ role: "user", content: proposalInput(checked) }],
        output_config: { effort: o.effort ?? "low", format: { type: "json_schema", schema: PROPOSAL_SCHEMA } },
      });
      if (response.stop_reason === "refusal") {
        const category = response.stop_details?.category;
        throw new Error(`refusal${category ? ` (${category})` : ""}`);
      }
      if (response.stop_reason !== "end_turn") throw new Error(`stopped at ${response.stop_reason ?? "no stop reason"}`);
      const text = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
      return fromStructured(JSON.parse(text));
    },
  };
}
