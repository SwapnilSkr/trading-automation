import { env } from "../config/env.js";

export interface JudgeInput {
  strategy: string;
  ticker: string;
  triggerHint: string;
  niftyContext?: string;
  newsHeadlines?: string[];
  similarPatternsSummary?: string;
}

export interface JudgeResult {
  confidence: number;
  reasoning: string;
  approve: boolean;
}

export async function callJudgeModel(
  input: JudgeInput,
  options?: { model?: string }
): Promise<JudgeResult> {
  const key = env.openRouterApiKey();
  const model = options?.model ?? env.judgeModel;
  const system = `You are a risk-aware intraday trading judge for Indian equities.
Respond ONLY with compact JSON: {"approve":boolean,"confidence":number,"reasoning":"string"}`;

  const user = [
    `Strategy: ${input.strategy}`,
    `Ticker: ${input.ticker}`,
    `Setup: ${input.triggerHint}`,
    input.niftyContext ? `Nifty: ${input.niftyContext}` : "",
    input.newsHeadlines?.length
      ? `News: ${input.newsHeadlines.slice(0, 5).join(" | ")}`
      : "",
    input.similarPatternsSummary ? `History: ${input.similarPatternsSummary}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  if (!key) {
    return {
      approve: false,
      confidence: 0,
      reasoning: "OPENROUTER_API_KEY missing — default deny",
    };
  }

  const res = await fetch(`${env.openRouterBaseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.2,
      max_tokens: 400,
    }),
  });

  if (!res.ok) {
    const t = await res.text();
    return {
      approve: false,
      confidence: 0,
      reasoning: `Judge HTTP ${res.status}: ${t}`,
    };
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const text = data.choices?.[0]?.message?.content ?? "{}";
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    return {
      approve: Boolean(raw.approve),
      confidence: Number(raw.confidence ?? 0),
      reasoning: String(raw.reasoning ?? ""),
    };
  } catch {
    return {
      approve: false,
      confidence: 0,
      reasoning: text.slice(0, 500),
    };
  }
}
