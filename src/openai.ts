import type OpenAI from "openai";
import { checkRequest, type Model } from "./model.ts";
import { fromStructured, INSTRUCTIONS, PROPOSAL_SCHEMA, proposalInput } from "./structured.ts";

export interface OpenAIOptions {
  client: OpenAI;
  model: string;
}

export function openaiModel(o: OpenAIOptions): Model {
  return {
    name: `openai:${o.model}`,
    timed: true,
    async propose(request) {
      const checked = checkRequest(request);
      const response = await o.client.responses.create({
        model: o.model,
        instructions: INSTRUCTIONS,
        input: proposalInput(checked),
        text: { format: { type: "json_schema", name: "proposal", strict: true, schema: PROPOSAL_SCHEMA } },
        store: false,
      });
      for (const item of response.output) {
        if (item.type !== "message") continue;
        for (const part of item.content) if (part.type === "refusal") throw new Error(`refusal: ${part.refusal}`);
      }
      if (response.status === "incomplete") throw new Error(`incomplete: ${response.incomplete_details?.reason ?? "no reason given"}`);
      if (response.status !== "completed") throw new Error(`response ${response.status ?? "has no status"}`);
      return fromStructured(JSON.parse(response.output_text));
    },
  };
}
