# Simple Operating Instructions

Use this file when you do not remember which command to run.

## Daily Control Panel

```bash
bun run ops
```

This opens the interactive operator console. Use it to:

- Check whether a date has its watchlist snapshot, news, OHLC bars, analyst lesson, and replay rows.
- Prepare or repair today if you started late.
- Replay/backtest a missed day.
- Run analyst for a missed day.
- Run nightly discovery manually.

Quick non-interactive checks:

```bash
bun run ops -- --status
bun run ops -- --date 2026-04-21 --status
```

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

Normal scheduled process: PM2 runs `nightly-discovery` around 18:20 IST.

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
