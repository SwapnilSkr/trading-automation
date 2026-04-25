/**
 * Cartesian grid builder for `backtest-research` (env key → list of string values).
 */

export function parseCommaValues(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Merge several preset record<string,string[]>: later presets override keys
 * (same as applying preset order left-to-right in CLI).
 */
export function mergeGrids(
  ...grids: Array<Record<string, string[]>>
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const g of grids) {
    for (const [k, v] of Object.entries(g)) {
      if (v.length > 0) out[k] = v;
    }
  }
  return out;
}

/**
 * Cartesian product of environment assignments.
 * `[[], { a:1 }]` is treated as a single no-op key dimension: returns `[{}]`
 * if the only keys have empty value arrays. Empty overall spec → `[{}]`.
 */
export function cartesianEnv(
  spec: Record<string, string[]>
): Record<string, string>[] {
  const keys = Object.keys(spec).filter(
    (k) => (spec[k]?.length ?? 0) > 0
  );
  if (keys.length === 0) return [{}];

  const result: Record<string, string>[] = [];
  const dfs = (i: number, acc: Record<string, string>) => {
    if (i >= keys.length) {
      result.push({ ...acc });
      return;
    }
    const key = keys[i]!;
    for (const val of spec[key]!) {
      dfs(i + 1, { ...acc, [key]: val });
    }
  };
  dfs(0, {});
  return result;
}

export function formatEnvLine(env: Record<string, string>, max = 200): string {
  const s = Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join(" | ");
  return s.length <= max ? s : s.slice(0, max) + "…";
}
