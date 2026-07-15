"use node";

import OpenAI from "openai";
import { z } from "zod";

const model = process.env.OPENROUTER_MODEL ?? "openai/gpt-4.1";

function client() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return null;
  return new OpenAI({ apiKey, baseURL: "https://openrouter.ai/api/v1" });
}

export async function draftReason(facts: string, fallback: string) {
  const api = client();
  if (!api) return fallback;
  try {
    const response = await api.chat.completions.create({ model, temperature: 0, max_tokens: 80, messages: [{ role: "system", content: "Write one factual sentence. Do not decide policy or invent facts." }, { role: "user", content: facts }] });
    return response.choices[0]?.message.content?.trim() || fallback;
  } catch { return fallback; }
}

const complianceSchema = z.object({ verdict: z.enum(["pass", "violation", "uncertain"]), reasoning: z.string().max(240) });

export async function judgeCompliance(brochure: string, rules: string[]) {
  const api = client();
  if (!api || !rules.length) return { verdict: "uncertain" as const, reasoning: rules.length ? "Compliance review needs configured model access." : "No company policy rules are configured." };
  try {
    const response = await api.chat.completions.create({
      model, temperature: 0, max_tokens: 120, response_format: { type: "json_object" },
      messages: [{ role: "system", content: "Classify only against supplied rules. Return JSON: {verdict: pass|violation|uncertain, reasoning: string}." }, { role: "user", content: `BROCHURE\n${brochure.slice(0, 12000)}\n\nRULES\n${rules.join("\n")}` }],
    });
    return complianceSchema.parse(JSON.parse(response.choices[0]?.message.content ?? "{}"));
  } catch { return { verdict: "uncertain" as const, reasoning: "Automated compliance classification failed; human review required." }; }
}

export async function embedText(text: string) {
  const api = client();
  if (!api) return null;
  try {
    const response = await api.embeddings.create({ model: "openai/text-embedding-3-small", input: text.slice(0, 8000), dimensions: 1536 });
    return response.data[0]?.embedding ?? null;
  } catch { return null; }
}
