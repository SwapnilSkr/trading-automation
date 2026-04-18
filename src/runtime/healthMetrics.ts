/** 0 until the first successful `orchestrator.tick()` completes */
let lastTickAtMs = 0;

export function markOrchestratorTick(): void {
  lastTickAtMs = Date.now();
}

export function getLastTickAtMs(): number {
  return lastTickAtMs;
}
