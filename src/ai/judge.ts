import { env } from "../config/env.js";

export interface JudgeInput {
  strategy: string;
  ticker: string;
  side?: string;
  triggerHint: string;
  niftyContext?: string;
  newsHeadlines?: string[];
  similarPatternsSummary?: string;
  /** Last N candles formatted as table for price context */
  priceContext?: string;
  /** Indicator summary (RSI, ATR, VWAP dist, EMAs) */
  indicators?: string;
  /** Rolling strategy track record */
  strategyTrackRecord?: string;
  /** Yesterday's lessons from analyst post-mortem */
  yesterdaysLessons?: string;
  /** INDEX_LAGGARD_CATCHUP: 5d index vs ticker divergence + intraday Nifty hold */
  indexLaggardContext?: string;
}

export interface JudgeResult {
  confidence: number;
  reasoning: string;
  approve: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

function extractJsonObject(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;

  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;

  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const fenced = fence?.[1]?.trim();
  if (fenced && fenced.startsWith("{") && fenced.endsWith("}")) return fenced;

  const start = trimmed.indexOf("{");
  if (start < 0) return undefined;

  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < trimmed.length; i++) {
    const ch = trimmed[i]!;
    if (inStr) {
      if (esc) {
        esc = false;
      } else if (ch === "\\") {
        esc = true;
      } else if (ch === "\"") {
        inStr = false;
      }
      continue;
    }

    if (ch === "\"") {
      inStr = true;
      continue;
    }
    if (ch === "{") depth += 1;
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) return trimmed.slice(start, i + 1);
    }
  }
  return undefined;
}

function parseJudgeText(text: string): JudgeResult {
  const jsonText = extractJsonObject(text);
  if (!jsonText) {
    return {
      approve: false,
      confidence: 0,
      reasoning: text.slice(0, 500),
    };
  }

  try {
    const raw = JSON.parse(jsonText) as Record<string, unknown>;
    // Some models (e.g. glm-5) return confidence as 0-100 integer instead of 0-1 float.
    // Normalise: if value is clearly on a 0-100 scale, divide by 100.
    let conf = Number(raw.confidence ?? 0);
    if (conf > 1 && conf <= 100) conf = conf / 100;
    return {
      approve: Boolean(raw.approve),
      confidence: clamp01(conf),
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

export async function callJudgeModel(
  input: JudgeInput,
  options?: { model?: string }
): Promise<JudgeResult> {
  const key = env.openRouterApiKey();
  const model = options?.model ?? env.judgeModel;
  const system = `You are a risk-aware intraday trading judge for Indian equities (NSE).
Evaluate setup quality, risk/reward ratio, and market context alignment.
Approve high-probability setups with favorable R:R. Deny weak setups, counter-trend trades in strong trends, or setups with negative catalyst risk.
Respond ONLY with compact JSON: {"approve":boolean,"confidence":number,"reasoning":"string"}
confidence must be a float 0.0–1.0 (NOT a percentage). Example: 0.72 means 72% confident.`;

  const sections: string[] = [
    `[SIGNAL]`,
    `Strategy: ${input.strategy} | Ticker: ${input.ticker}${input.side ? ` | Side: ${input.side}` : ""}`,
    `Setup: ${input.triggerHint}`,
  ];

  if (input.priceContext) {
    sections.push(`\n[PRICE ACTION]`, input.priceContext);
  }

  if (input.indicators) {
    sections.push(`\n[INDICATORS]`, input.indicators);
  }

  if (input.similarPatternsSummary) {
    sections.push(`\n[PATTERN MEMORY]`, input.similarPatternsSummary);
  }

  if (input.strategyTrackRecord) {
    sections.push(`\n[STRATEGY TRACK RECORD]`, input.strategyTrackRecord);
  }

  if (input.niftyContext) {
    sections.push(`\n[MARKET CONTEXT]`, `Nifty: ${input.niftyContext}`);
  }

  if (input.indexLaggardContext) {
    sections.push(`\n[INDEX LAGGARD]`, input.indexLaggardContext);
  }

  if (input.newsHeadlines?.length) {
    sections.push(`News: ${input.newsHeadlines.slice(0, 5).join(" | ")}`);
  }

  if (input.yesterdaysLessons) {
    sections.push(`\n[YESTERDAY'S LESSONS]`, input.yesterdaysLessons);
  }

  const user = sections.join("\n");

  if (!key) {
    return {
      approve: false,
      confidence: 0,
      reasoning: "OPENROUTER_API_KEY missing — default deny",
    };
  }

  const maxAttempts = 3;
  let lastError = "unknown";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
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
          max_tokens: 1024,
          response_format: { type: "json_object" },
        }),
      });

      if (!res.ok) {
        const t = await res.text();
        lastError = `Judge HTTP ${res.status}: ${t}`.slice(0, 500);
        const retryable = res.status === 429 || res.status >= 500;
        if (retryable && attempt < maxAttempts) {
          await sleep(attempt * 500);
          continue;
        }
        return { approve: false, confidence: 0, reasoning: lastError };
      }

      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const text = data.choices?.[0]?.message?.content ?? "{}";
      return parseJudgeText(text);
    } catch (err) {
      lastError =
        err instanceof Error ? err.message : `Judge fetch error: ${String(err)}`;
      if (attempt < maxAttempts) {
        await sleep(attempt * 500);
        continue;
      }
      return {
        approve: false,
        confidence: 0,
        reasoning: lastError.slice(0, 500),
      };
    }
  }

  return { approve: false, confidence: 0, reasoning: lastError.slice(0, 500) };
}
