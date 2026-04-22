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
- See which recent trading days are incomplete (backlog audit) and why.
- Prepare or repair today if you started late.
- Replay/backtest a missed day.
- Replay/backtest a custom date range directly from the menu.
- Run analyst for a missed day.
- Run nightly discovery manually.

Operator menu quality-of-life:

- Press `Enter` to refresh status.
- Use `Run suggested action (sentinel)` to auto-run the best next step based on gaps and current phase.
- Use `Repair missing trading days (guided)` to repair backlog days one by one (oldest to newest).
- Type aliases like `date`, `replay`, `range`, `prepare`, `analyst`, `help`.
- After changing date, the CLI asks what you want to do next for that date.

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
