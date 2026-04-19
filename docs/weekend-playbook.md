# Weekend Playbook

Every Saturday/Sunday you run this playbook to fill data, validate strategies, and improve the Pinecone memory. Do this before every live paper trading week.

---

## Why the weekend?

- Angel SmartAPI only serves historical 1m OHLC data (not live ticks on weekends)
- NSE is closed → no noise, perfect time to backtest and tune
- Pinecone pattern mining is slow (6 months of 1m data per ticker) — do it overnight
- Monday morning the daemon starts with fresh discovery list and warm Pinecone memory

---

## Saturday: Fill → Mine → Validate

### Phase 1 — Fill the data tank (~1–3 hours depending on Angel rate limits)

Run these in order. They talk to Angel SmartAPI and are rate-limited.

**1a. Score Nifty 100 + backfill top 20 stocks (30 days of 1m OHLC)**
```bash
bun run discovery-sync -- --days 30 --top 20
# Recommended periodically: refresh the index constituent list from NSE (updates data/ind_nifty100list.csv)
bun run discovery-sync -- --days 30 --top 20 --refresh-universe
```
What this does:
- Loads all 100 Nifty 100 symbols from **`data/ind_nifty100list.csv`** (bundled copy). Without **`--refresh-universe`**, every run uses that same file until you refresh it. With **`--refresh-universe`**, it tries to download the official NSE Nifty 100 CSV and overwrite the file on success; on failure it falls back to disk.
- The **daemon nightly** discovery (POST_MORTEM) does **not** refresh the CSV — only the on-disk list — unless you change the code. Use **`--refresh-universe`** on your weekend CLI run if you want the current index membership.
- Fetches 5-day daily OHLC for each via Angel
- Scores: `|5-day return| × (last vol / avg vol)` — momentum × volume interest
- Takes the top 20 by score
- Writes them to `active_watchlist.current_session` in Mongo (this is your trading list)
- Writes a dated `watchlist_snapshots` entry (used by backtest for no-lookahead)
- Backfills 30 days of 1m OHLC for the top 20

Expect: ~40–60 min (2000ms delay between 100 symbols + 450ms per candle chunk)

**1b. Fill NIFTY50 index bars (needed for macro trend context)**
```bash
bun run sync-history -- --days 30 --ticker NIFTY50
```
The live judge receives a string like `"NIFTY50 bearish trend, -0.8% from open, below VWAP"` from Mongo 1m data. Without this, the judge gets no macro filter.

**1c. Backfill daily news (`news_context`)**
```bash
bun run backfill-news-scraper -- --from 2026-03-01 --to 2026-04-17
```
Scrapes ET archive headlines per day into Mongo **`news_context`** (one document per **`date`**, used by **`fetchTodayNewsContext`** for **live** / same-day judge context).

**Backtests** read **`news_archive`** (documents with a **`ts`** field) and optional **`HISTORICAL_NEWS_PATH`** JSON — not `news_context`. To give the judge headlines during replay, use e.g. `bun run backtest -- --import-news your.json` (loads into `news_archive`) or maintain `data/historical_news.json`. See `README.md` → MongoDB collections.

Expect: ~2–3 min (2.5s delay between days; scraper retries on transient failures)

---

### Phase 2 — Mine patterns into Pinecone (let this run overnight if needed)

```bash
bun run weekend-optimize
```

What this does:
- Finds every ticker in Mongo with ≥500 1m bars in the last 6 months
- Merges with `active_watchlist` and `WATCHED_TICKERS`
- For each ticker, walks all 1m bars: finds bars with >2% forward move in the next 30 minutes
- Classifies each as WIN (price went up) or LOSS (price went down)
- Embeds the preceding 30-bar price pattern (log-returns → `text-embedding-3-small` → 1536-dim vector)
- Upserts to Pinecone with `{outcome, pnl_percent, date, ticker, strategy}`
- Runs a quick hybrid backtest sample on the primary ticker

After this runs, the live system can auto-approve trades that closely match historical WIN patterns without calling the LLM judge.

Expect: 30 min to several hours depending on how many tickers and candles are in Mongo.

**If the job stops mid-run** (laptop sleep, crash): it does **not** have to redo everything. By default, progress is stored in Mongo (`weekend_optimize_checkpoint`): on the **same IST calendar day** with the **same ticker universe**, finished tickers are skipped. For any ticker you run again, vectors whose ids already exist in Pinecone skip OpenAI embedding and upsert (cheap Pinecone `fetch` batches). If you resume on a **later calendar day**, the checkpoint is reset, but **Pinecone still skips** existing ids so you do not pay again for embeddings already stored. Use `--no-resume` to ignore the checkpoint for that run, and `--re-embed-all` to force fresh embeddings even when ids exist. See `docs/env-reference.md` for `WEEKEND_OPTIMIZE_*` toggles.

---

### Phase 3 — Backtest and analyze

**Run the backtest:**
```bash
bun run backtest -- --from 2026-03-01 --to 2026-04-17 --watchlist-snapshots
```

Flags explained:
- `--from/--to`: IST date range (must have Mongo data for this window)
- `--watchlist-snapshots` (or `--ticker-source snapshots`): uses `watchlist_snapshots` per day (no-lookahead — realistic)
- `--ticker-source static --tickers RELIANCE,TCS`: use fixed tickers every day
- `--skip-judge`: deterministic technical-only mode (bypasses LLM, auto-approves technical triggers)
- `--no-persist`: dry run, don't write to trades_backtest

The backtest now produces complete trades with entry + exit prices and PnL. It simulates stop-loss, profit target, and trailing stop bar-by-bar using actual 1m candle data.
Replay defaults to execution-realistic net PnL (entry latency, spread/slippage/impact, and modeled charges/taxes). See `docs/env-reference.md` (`Backtest Realism` section) to tune aggressiveness.

Bias control in replay:
- Backtest memory lookup now uses only Pinecone neighbors from dates strictly before the simulated bar day (causal; no future-day leakage).
- Keep `--watchlist-snapshots` enabled for realistic universe selection per day.

**Analyze results:**
```bash
bun run backtest-analyze -- --last
```

Example output:
```
── OVERALL ─────────────────────────────────
  Trades (with exits):  87  |  Wins: 52  Losses: 31  BE: 4
  Win Rate:             59.8%
  Total PnL:            ₹18,420
  Avg Win / Avg Loss:   ₹640 / ₹-290
  Profit Factor:        2.15
  Max Drawdown:         ₹4,200
  Sharpe (est):         1.84

── ORB_15M ─────────────────────────────────
  ...
── MEAN_REV_Z ──────────────────────────────
  ...
```

---

### Phase 4 — Tune if needed

Based on the analyze output:

| Problem | Fix |
|---------|-----|
| Win rate OK but profit factor < 1.2 | Targets too small → increase `EXIT_TARGET_PCT=0.03` |
| Many small losses eating profits | Stops too loose → tighten `EXIT_STOP_PCT=0.01` |
| Good wins but large drawdown | Reduce `EXIT_TRAIL_TRIGGER_PCT=0.008` to trail sooner |
| Very few trades generated | Entry signals too strict; lower Z-score threshold or ORB volume requirement |
| Too many losing entries | Signals too loose; raise Z-score from 2.5 to 3.0 in `src/strategies/triggers.ts:42` |

After tuning, re-run backtest + analyze to validate.

---

## Sunday: Out-of-sample validation

Repeat the backtest on a **different date range** than you tuned on:

```bash
# You tuned on March–April → validate on January–February
bun run backtest -- --from 2026-01-01 --to 2026-02-28 --watchlist-snapshots
bun run backtest-analyze -- --last
```

If profit factor stays > 1.5 on unseen data → strategy has real edge, not curve-fitted.
If profit factor drops below 1.0 on unseen data → you overfit to March–April; rethink.

---

## Monday morning checklist (before market opens)

```bash
# Verify active_watchlist is populated for today
# (should have been set by Saturday's discovery-sync or Sunday's nightly run)
mongosh trading-automation --eval "db.active_watchlist.findOne()"

# Verify OHLC exists for the tickers
mongosh trading-automation --eval "db.ohlc_1m.countDocuments()"

# Verify news_context has today's date (or recent)
mongosh trading-automation --eval "db.news_context.findOne({}, {sort: {date: -1}})"

# Start the daemon
bun run start
```

The daemon will handle everything from here: pre-open pivot at 09:10, news refresh, live scanning, exit management, and nightly discovery.

---

## Routine weekly schedule

| Day | Task |
|-----|------|
| Saturday | Fill data (discovery-sync + sync-history + backfill-news) |
| Saturday evening | weekend-optimize (let run overnight) |
| Sunday morning | Backtest + analyze |
| Sunday afternoon | Tune params + out-of-sample validation |
| Sunday evening | Verify Monday watchlist, start daemon if needed |
| Weekday 15:45 IST | evening-analyst auto-runs (PM2) → lessons_learned |
| Weekday 18:20 IST | nightly-discovery auto-runs (PM2) → refreshes active_watchlist |
| Next weekend | Repeat |
