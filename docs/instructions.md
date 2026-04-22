# Simple Operating Instructions

Use this file when you do not remember which command to run.

## Start Live Trading (Simple Steps)

Think of it like this:

- `ops` = your control room (checks and prepares things)
- `start` = your engine (actual live daemon loop)

Do this every trading day:

1. Open terminal 1 and run:

```bash
bun run ops
```

2. In `ops`, choose `Prepare/resume trading for selected date`.

3. Open terminal 2 and start the daemon:

```bash
bun run start
```

4. Check health (optional):

```bash
curl http://127.0.0.1:3000/health
```

If you use PM2 instead of foreground mode:

```bash
bun run build
pm2 start ecosystem.config.cjs
pm2 logs trading-bot
```

If you prepared in `ops` and then restarted during market hours, that is fine. The daemon resumes and keeps running its phase loop.

## Daily Control Panel

```bash
bun run ops
```

This opens the interactive operator console. Use it to:

- Check whether a date has its watchlist snapshot, news, OHLC bars, analyst lesson, and replay rows.
- See a live decision funnel (`total -> risk veto -> cooldown -> other deny -> executed`) for the selected day.
- See which recent trading days are incomplete (backlog audit) and why.
- Prepare or repair today if you started late.
- Replay/backtest a missed day.
- Replay/backtest a custom date range directly from the menu.
- Replay a custom date range in side-by-side comparison mode (baseline realistic + research microstructure profile).
- Run analyst for a missed day.
- Run nightly discovery manually.

Operator menu quality-of-life:

- Press `Enter` to refresh status.
- Use `Run suggested action (sentinel)` to auto-run the best next step based on gaps and current phase.
- Use `Judge cooldown status` to see whether strategy:ticker judge cooldown keys are active right now and remaining time.
- Use `Repair missing trading days (guided)` to repair backlog days one by one (oldest to newest).
- Type aliases like `date`, `replay`, `range`, `prepare`, `analyst`, `help`.
- After changing date, the CLI asks what you want to do next for that date.

Layman note:
- If portfolio risk caps are almost full, the system now tries to place a smaller quantity first (fit-to-headroom) before rejecting.
- In `ops` status, watch the decision funnel line to see if blocks are mostly `risk_veto`, `cooldown`, or `deny_other`.
- The system now ranks trigger candidates and checks top ones first; it does not waste time on every weak trigger.
- If your max positions are already full, it can replace the weakest open trade only when a clearly better new setup appears.
- Judge cooldown is now adaptive: stronger setups are retried sooner, weaker setups wait longer.
- Confidence is now dual-tracked: `ai_confidence_raw` (model output) and calibrated `ai_confidence` (used by sizing logic).

Quick non-interactive checks:

```bash
bun run ops -- --status
bun run ops -- --date 2026-04-21 --status
```

## AI Operator CLI (contextual)

```bash
bun run ops-ai
bun run ops-ai -- --date 2026-04-21
```

The AI CLI uses `google/gemma-4-31b-it:free` via your OpenRouter key, reads live Mongo-backed status each turn, and can run contextual actions such as prepare day, replay day, analyst, discovery, and sync.

Examples to type inside `ops-ai`:

- `prepare today so i can resume now`
- `replay 2026-04-18 with skip judge`
- `run analyst for 2026-04-18`
- `show status`

Slash commands:

- `/status`
- `/date YYYY-MM-DD`
- `/help`
- `/exit`

## If You Start Trading Late

```bash
bun run ops -- --prepare
```

This refreshes today's news, recovers `active_watchlist` from today's snapshot if possible, creates the snapshot if you approve it, and syncs today's 1m bars from 09:15 to now. After that, start or restart the daemon:

```bash
bun run start
```

With PM2:

```bash
pm2 restart trading-bot
```

## Replay A Missed Day

```bash
bun run ops -- --date YYYY-MM-DD --replay
```

The CLI checks for that day's snapshot and OHLC coverage, offers to repair missing pieces, runs a one-day replay, and can run the analyzer for the replay run.
If you keep judge enabled, `ops` now also shows whether historical `news_archive` exists before the replay date and lets you override judge model at run time.

## Compare Realism Profiles (Range Replay)

Inside `bun run ops`, choose:

- `Replay/backtest a custom date range`
- Then answer `yes` to: `Run side-by-side realism comparison (baseline + research profile)?`

What it does:

- Run 1: your normal baseline replay (unchanged defaults)
- Run 2: same engine and strategy logic, but with softer execution-friction assumptions for comparison:
  - `BACKTEST_ENTRY_LATENCY_BARS=0`
  - `BACKTEST_PESSIMISTIC_INTRABAR=false`
  - `BACKTEST_SPREAD_BPS=1.0`
  - `BACKTEST_BASE_SLIPPAGE_BPS=0.5`
  - `BACKTEST_IMPACT_BPS_PER_1PCT_PARTICIPATION=0.10`
  - `BACKTEST_VOLATILITY_SLIPPAGE_COEFF=0.03`

Notes:

- This does **not** change your default backtest behavior.
- Both run IDs are printed; compare their analyzer output directly.
Replay prep now auto-fetches ET archive headlines for replay weekdays by default and deduplicates on upsert, so repeated replays do not accumulate duplicate headlines for the same day.

## End-Of-Day Analyst

For today:

```bash
bun run analyst
```

For a missed day:

```bash
bun run analyst -- --date YYYY-MM-DD
```

The interactive console can also run this from the menu.

## Nightly Discovery

Normal scheduled process: daemon runs nightly discovery in POST_MORTEM window (18:00–21:00 IST) when `NIGHTLY_DISCOVERY=true`.

Manual repair:

```bash
bun run ops
```

Choose `Run nightly discovery from this day`. It scores Nifty 100 as of that date and writes the next session's `watchlist_snapshots` and `active_watchlist`.

## Backfill Market Data Manually

```bash
bun run sync-history -- --from YYYY-MM-DD --to YYYY-MM-DD --tickers RELIANCE,TCS,INFY
```

Prefer `bun run ops` for day repair because it chooses the right snapshot tickers and session window.

## Backtest Manually

```bash
bun run backtest -- --from YYYY-MM-DD --to YYYY-MM-DD --watchlist-snapshots --skip-judge
bun run backtest-analyze -- --last
```

Prefer `bun run ops -- --date YYYY-MM-DD --replay` for a missed day because it checks prerequisites first.

If you run `backtest-snapshots` directly with judge enabled, it now prints replay config (`skipJudge`, effective judge model) and warns when `news_archive` is empty for the range:

```bash
bun run backtest-snapshots -- --from YYYY-MM-DD --to YYYY-MM-DD --judge-model deepseek/deepseek-chat
bun run backtest-snapshots -- --from YYYY-MM-DD --to YYYY-MM-DD --fail-on-missing-news # fail when news coverage is missing/weak
bun run backtest-snapshots -- --from YYYY-MM-DD --to YYYY-MM-DD --news-min-headlines 12
```

## Confidence Calibration Check (Simple)

Use this when you want to verify whether model confidence aligns with real outcomes:

```bash
bun run confidence-calibration-report -- --days 20 --env PAPER --field raw
bun run confidence-calibration-report -- --days 20 --env PAPER --field final
```

How to read it:
- `raw` = what the model said.
- `final` = after runtime calibration based on recent realized trades.
- If `final` buckets are more stable than `raw`, keep calibration enabled.
