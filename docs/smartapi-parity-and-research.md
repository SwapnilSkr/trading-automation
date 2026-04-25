# SmartAPI execution, live vs backtest parity, and research

This doc complements the **SmartAPI-aligned execution** plan: what behaves differently in replay vs the live daemon, how to calibrate fiction from measured live metrics, and how OOS research fits a human review step.

## Live vs backtest parity (checklist)

| Mechanism | Live daemon (`src/index.ts` + `TradingOrchestrator`) | Backtest / replay |
|-----------|--------------------------------------------------------|----------------------|
| **1m bars** | Mongo `ohlc_1m` + execution-time sync | Same collection or file-backed OHLC; no WebSocket |
| **Market WebSocket LTP** | `ensureMarketLtpStream` + `getLastLtpFromStream` → `ExecutionEngine.checkLiveExits` widens effective bar range | Not simulated unless you add tick replay; exits use bar OHLC only |
| **FULL quote / circuits** | Throttled NIFTY + top-K via `fetchThrottledCircuitProximity` → `MarketRegimeSnapshot` | Not automatic; optional daily snapshot in future |
| **Judge / Pinecone** | Full pipeline; `LIVE_SKIP_JUDGE` can bypass the LLM | `JUDGE_MODEL_BACKTEST` and `skipJudge` / replay flags as configured |
| **Order lifecycle** | Postback `POST /v1/angel/postback`, `order_lifecycle_events`, PAPER synthetic events | No postback; trades written as in `BacktestOrchestrator` |
| **PAPER** | `EXECUTION_ENV!=LIVE` — no `placeOrder`; `recordSyntheticPaperOrder` exercises lifecycle | Usually `trades_backtest` or inject `onTradeEntry` |
| **LIMIT / modify** | `EXECUTE_LIMIT_ORDERS`, `orderPolicy`, broker REST when LIVE | `BACKTEST_LIMIT_TOUCH_FILL` + `applyLimitFillAtBarTouch` in `backtest/microstructure.ts` (optional) |

## Calibrating backtest friction from live

1. **Phase-1 style metrics** (slippage, reject rate) after live sessions: export aggregates monthly and adjust `backtest/microstructure.ts` or env (`BACKTEST_*` realism) to match *ranges*, not a single point.
2. **Walk-forward** (`bun run walk-forward-backtest`): align test windows with stable friction assumptions; re-run when broker or regime changes.
3. **Funnel / phase-8** reports: treat execution-rate and drawdown guardrails as *operational* checks, not proof of edge.

## OOS research and review

- `bun run backtest-research` supports `--validate-from` / `--validate-to` for holdout checks; use exports as **candidates** for review, not auto-production defaults.
- Keep a short written note (why this config, what failed in OOS) next to any promoted parameter set in version control.
- Nightly/weekly jobs (see `AGENTS` / `daemonEveningJobsEnabled`) are observation windows — do not conflate with walk-forward *statistical* validity.

## Environment reference (new / relevant)

| Variable | Role |
|----------|------|
| `ANGEL_POSTBACK_SECRET` | If set, postback must send header `x-postback-secret` |
| `ORDER_RECONCILIATION_POLL_MS` | LIVE poll `getOrderBook` (ms), 0 = off |
| `MARKET_WS_ENABLED` | Market WebSocket LTP stream |
| `ORDER_RECONCILIATION_*` / `MARKET_*` / `FULL_QUOTE_*` / `CIRCUIT_PROXIMITY_VETO_PCT` | Throttle and risk gates |
| `EXECUTE_LIMIT_ORDERS` / `PAPER_SIMULATE_LIMIT_FILLS` / `AGGRESSIVE_LIMIT_TICK_OFFSET` | Limit path (LIVE real API when `EXECUTION_ENV=LIVE`) |
| `BACKTEST_LIMIT_TOUCH_FILL` | Optional limit-touch fill hook in backtest microstructure |

## Code touchpoints

- **Exits + LTP:** `ExecutionEngine.checkLiveExits` — optional `lastLtp` from `src/services/marketLtpStream.ts`.
- **Entry orders:** `buildEntryOrderParams` in `src/execution/orderPolicy.ts` → `placePaperOrder`.
- **Reconciliation:** `ingestOrderPayload` in `src/services/orderLifecycleService.ts`; poll in `src/services/orderReconciliationPoll.ts`.
- **Circuit gate:** `src/services/fullQuoteRisk.ts` + `evaluateMarketRegime` in `src/risk/marketRegime.ts`.
