import { istDateString } from "../time/ist.js";
import { getNewsForDate, upsertNews } from "../db/repositories.js";

/** Replace with real news API (Economic Times RSS, etc.) */
export async function fetchTodayNewsContext(): Promise<string[]> {
  const date = istDateString();
  const existing = await getNewsForDate(date);
  if (existing?.headlines?.length) return existing.headlines;

  const headlines = [
    "Placeholder: wire real macro/sector headlines before live trading",
  ];
  await upsertNews({ date, headlines, source: "stub" });
  return headlines;
}
