# Backtest research (grid search)

This page explains **`bun run backtest-research`**: a command that runs many historical replays while **only changing environment variables** (no code changes). It is how you hunt for better **stops, targets, friction, and gates** on a fixed date range—**without the LLM judge** if you pass `--skip-judge`.

If you only need “turn on one strategy at a time” comparisons, use **`bun run backtest-ablation`** instead. Research mode is for **combining** those ideas with **numeric sweeps**.

---

## Plain-English idea

1. You pick a **calendar window** (for example one month of trading days).
2. You describe a **small set of choices** for the engine: for example “try three different ATR stop widths and three different profit targets.”
3. The tool runs the full **snapshot replay pipeline** once per combination (`backtest-snapshots`: watchlist union, optional broker sync, realistic costs, exits, PnL in Mongo).
4. It reads completed trades from **`trades_backtest`**, computes **profit factor, PnL, drawdown**, and writes a **sortable table** (JSON + CSV) so you can compare runs.

**Important:** getting a high profit factor on one month is **not proof** the same settings will work next month. Use **out-of-sample** windows (`--validate-from` / `--validate-to`) when you can, or different calendar months, before trusting a configuration.

---

## The algorithm in simple terms

1. **Build a grid**  
   - Start from your **base `.env`** (live defaults are *not* changed on disk; each child process only gets a copy of the environment with temporary overrides).  
   - If you use **`--profiles`**, apply that profile’s `BACKTEST_ENABLE_*` bundle first (from `src/backtest/backtestProfiles.ts`).  
   - Merge **presets** (`--preset quick`, `--preset atrrisk`, …) and **custom axes** (`--set KEY=a,b,c`).  
   - Form the **Cartesian product**: every value of every key is tried in combination with the others (same idea as a nested `for` loop for each variable).

2. **Plan size guard**  
   - The tool counts: `profiles × (product of value counts) × (2 if you added validation)`.  
   - If the plan exceeds `--max-runs` (default `200`), it stops unless you pass **`--allow-huge`**. This prevents a typo like `1,1.1,1.2,...,9` from launching thousands of replays by accident.

3. **Clear once, then stack runs**  
   - By default it **deletes all** `trades_backtest` rows at the start.  
   - Each run calls `backtest-snapshots` with **`--no-clear-trades`**, so every run’s trades stay in the collection with a **new `backtest_run_id`**.  
   - The research command loads the right rows **by run id** when scoring.

4. **Score each run**  
   - Same core math as `backtest-analyze` (gross profit / gross loss, sequential drawdown, etc.); see `src/backtest/tradeMetrics.ts`.

5. **Optional second window (validation / OOS)**  
   - If you set **`--validate-from`** and **`--validate-to`**, every grid point runs **twice** with the *same* env: once on the training range, once on the validation range.  
   - The report includes both **train** and **OOS** metrics. Sorting with **`--sort oos-pf`** ranks by out-of-sample profit factor (rows without OOS sort last).

6. **Export**  
   - Writes `reports/<tag>-<timestamp>.json` and `.csv` with one row per attempted grid point (errors recorded if a replay failed).

---

## Command examples

**Small smoke test (4 runs)** — ATR stop × ATR target quick grid, no LLM, no new OHLC download:

```bash
bun run backtest-research -- \
  --from 2026-03-01 --to 2026-03-28 \
  --preset quick --skip-judge
```

**Strategy profile × exit grid** — only mean reversion, sweep exits:

```bash
bun run backtest-research -- \
  --from 2026-03-01 --to 2026-03-28 \
  --profiles meanrev-only \
  --preset atrrisk --skip-judge
```

**Custom two-axis sweep** (no named preset):

```bash
bun run backtest-research -- \
  --from 2026-03-01 --to 2026-03-25 \
  --set ATR_STOP_MULTIPLE=1,1.5,2 --set ATR_TARGET_MULTIPLE=2,2.5,3 \
  --skip-judge
```

**Train + out-of-sample** (doubles the number of replays per combo):

```bash
bun run backtest-research -- \
  --from 2026-03-01 --to 2026-03-20 \
  --validate-from 2026-03-21 --validate-to 2026-03-28 \
  --preset quick --skip-judge --sort oos-pf
```

**Plan without running** (count + first few combinations):

```bash
bun run backtest-research -- \
  --from 2026-03-01 --to 2026-03-28 \
  --preset atrrisk --dry-run
```

**Broker sync** (first time or new tickers; uses Angel API limits like other backtest CLIs):

```bash
bun run backtest-research -- \
  --from 2026-03-01 --to 2026-03-28 \
  --preset quick --sync --skip-judge
```

---

## Built-in presets (names for `--preset`)

| Preset        | What it varies | Rough combo count* |
|---------------|----------------|--------------------|
| `quick`       | 2×2 ATR stop and target | 4 |
| `atrrisk`     | 3×3 ATR stop and target | 9 |
| `trail`       | trail trigger and distance (ATR mults) | 9 |
| `gates`       | `BACKTEST_SESSION_POLICY_ENABLED` × `BACKTEST_MARKET_GATE_ENABLED` | 4 |
| `micro`       | `BACKTEST_BASE_SLIPPAGE_BPS` × `BACKTEST_SPREAD_BPS` | 9 |
| `vol-regime`  | `VOL_REGIME_SWITCH_ENABLED` | 2 |
| `fixed-pct`   | `EXIT_STOP_PCT` × `EXIT_TARGET_PCT` (use with `ATR_EXITS_ENABLED=false` if you test fixed-% exits) | 9 |

\*You can list multiple `--preset` flags; those grids **merge** (same key: **later** preset overwrites). Then they **multiply** in the Cartesian product with every other key—be careful, combinations grow fast.

Full key lists: `src/backtest/researchPresets.ts`.

---

## Flags reference (cheat sheet)

| Flag | Role |
|------|------|
| `--from` / `--to` | Training (primary) date range, IST, `YYYY-MM-DD` |
| `--validate-from` / `--validate-to` | Optional second range (OOS) |
| `--profiles` | Comma list of ablation profile keys (same as `backtest-ablation`) |
| `--preset` | Repeatable. Named small grids (see table above) |
| `--set KEY= a,b` | Repeatable. Custom env axis |
| `--skip-judge` | No LLM; faster, reproducible “technical + rules” path |
| `--judge-model` | Passed through to `backtest-snapshots` when judge is on |
| `--step` | Replay scan step in minutes (default 15) |
| `--sync` / `--no-sync` | Forwarded: whether to backfill 1m OHLC before replay |
| `--force-sync-all` | Skip coverage precheck, sync every snapshot ticker |
| `--no-clear-first` | Do **not** wipe `trades_backtest` at start (mixes with old runs) |
| `--min-trades` / `--min-pf` | Filter the **ranked** table (train segment only) |
| `--sort` | `train-pf` (default), `oos-pf`, `min-pf`, PnL, `train-sharpe` |
| `--max-runs` / `--allow-huge` | Safety cap on total `backtest-snapshots` spawns |
| `--continue-on-error` | Log failure row and keep going |
| `--dry-run` | Print plan only |
| `--out-dir` / `--tag` | Report location and filename prefix |
| `--quiet` | Less console output |

---

## How this relates to other commands

- **`backtest-snapshots`** — one run; sync + replay + optional analyze.  
- **`backtest-ablation`** — many runs, but only **one dimension** (which strategies are on). Reuses the same `PROFILE_SPECS` as research.  
- **`backtest-research`** — many runs, **Cartesian** over any env keys you add with presets and `--set`, optionally **multiplied** by profiles.  
- **`walk-forward-backtest`** — time splits only (no parameter grid).  
- **`backtest-analyze`** — read any `trades_backtest` run id after the fact.

---

## Files to read in the repo

- `src/cli/backtest-research.ts` — CLI and orchestration  
- `src/backtest/researchPresets.ts` — built-in named grids  
- `src/backtest/researchGrid.ts` — Cartesian merge helpers  
- `src/backtest/tradeMetrics.ts` — PnL / PF / drawdown for a run id  
- `src/backtest/backtestProfiles.ts` — strategy profile env bundles
