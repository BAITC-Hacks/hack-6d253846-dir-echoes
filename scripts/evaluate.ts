import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { routeUtterance } from "../src/lib/ai";
import { loadDatasetFromPath } from "../src/lib/dataset";
import type { DialogueState, RouterOutput } from "../src/lib/types";

const HELP = `Run real LLM routing against the organizer's development set.
Usage: npm run evaluate -- --limit 10 [--concurrency 2] [--max-usd 1] [--out work/evaluations/run]
Required environment: DATASET_PATH, OPENAI_API_KEY.
--limit is mandatory so this command never starts a full paid run implicitly.
Concurrency is limited to 2. No retries. Cost is estimated from model token usage.
Output: predictions.json (official evaluator format), report.json, dev_subset.json.
For a bounded run, use the official evaluate.py with dev_subset.json as its second argument.
The development labels are used only for scoring after routeUtterance returns.
`;

const devSchema = z.object({
  utterances: z.array(z.object({ id: z.string(), text: z.string(), lang: z.string(), expected: z.array(z.string()).min(1), type: z.string() })).min(1),
});
type DevUtterance = z.infer<typeof devSchema>["utterances"][number];
type EvaluationRow = {
  id: string; lang: string; type: string; expected: string[]; predicted: string[];
  primaryCorrect: boolean; fullMatch: boolean; elapsedMs: number;
  inputTokens: number; outputTokens: number; estimatedUsd: number;
  error?: string; skipped?: boolean;
};

function freshState(): DialogueState {
  return { language: "ru", activeScenarioId: null, pendingScenarioIds: [], suspendedScenarioIds: [], completedScenarioIds: [], slots: {}, slotsByScenario: {}, clientId: null, pendingConfirmation: null, unclearCount: 0, lastQuestionSlot: null, lookupFailures: 0, status: "active" };
}

function score(utterance: DevUtterance, result?: RouterOutput, error?: string, skipped = false): EvaluationRow {
  const predicted = result?.decision.scenarios.map((s) => s.scenarioId) ?? [];
  return {
    id: utterance.id, lang: utterance.lang, type: utterance.type, expected: utterance.expected, predicted,
    primaryCorrect: predicted[0] === utterance.expected[0],
    fullMatch: predicted.length === new Set(utterance.expected).size && utterance.expected.every((id) => predicted.includes(id)),
    elapsedMs: result?.elapsedMs ?? 0, inputTokens: result?.inputTokens ?? 0, outputTokens: result?.outputTokens ?? 0,
    estimatedUsd: result?.estimatedUsd ?? 0, ...(error ? { error } : {}), ...(skipped ? { skipped: true } : {}),
  };
}

function metrics(rows: EvaluationRow[]) {
  const groups: Record<string, { n: number; primaryAccuracy: number; fullMatch: number }> = {};
  const keys = ["all", ...new Set(rows.map((r) => `lang=${r.lang}`)), ...new Set(rows.map((r) => `type=${r.type}`))];
  for (const key of keys) {
    const group = key === "all" ? rows : rows.filter((r) => key === `lang=${r.lang}` || key === `type=${r.type}`);
    groups[key] = { n: group.length, primaryAccuracy: group.length ? group.filter((r) => r.primaryCorrect).length / group.length : 0, fullMatch: group.length ? group.filter((r) => r.fullMatch).length / group.length : 0 };
  }
  const multi = rows.filter((r) => r.type === "multi_intent");
  const expectedIntentCount = multi.reduce((sum, r) => sum + new Set(r.expected).size, 0);
  const recognizedIntentCount = multi.reduce((sum, r) => sum + [...new Set(r.expected)].filter((id) => r.predicted.includes(id)).length, 0);
  const latencies = rows.filter((r) => !r.error && !r.skipped).map((r) => r.elapsedMs).sort((a, b) => a - b);
  const middle = Math.floor(latencies.length / 2);
  return { groups, multiIntentRecall: expectedIntentCount ? recognizedIntentCount / expectedIntentCount : null, routerLatencyMedianMs: latencies.length ? (latencies.length % 2 ? latencies[middle] : (latencies[middle - 1] + latencies[middle]) / 2) : null };
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) { console.log(HELP); return; }
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!["--limit", "--concurrency", "--max-usd", "--out"].includes(argv[i]) || !argv[i + 1] || argv[i + 1].startsWith("--")) throw new Error(HELP);
    flags[argv[i]] = argv[i + 1];
  }
  const limit = Number(flags["--limit"]);
  const concurrency = Number(flags["--concurrency"] ?? "2");
  const maxUsd = Number(flags["--max-usd"] ?? "1");
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error("Specify an explicit --limit between 1 and 1000.");
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 2) throw new Error("--concurrency must be 1 or 2.");
  if (!Number.isFinite(maxUsd) || maxUsd < 0.05 || maxUsd > 25) throw new Error("--max-usd must be between 0.05 and 25.");
  if (!process.env.DATASET_PATH || !process.env.OPENAI_API_KEY) throw new Error("Set DATASET_PATH and OPENAI_API_KEY before running evaluation.");
  const datasetPath = path.resolve(process.env.DATASET_PATH);
  const dataset = await loadDatasetFromPath(datasetPath);
  const source = devSchema.parse(JSON.parse(await readFile(path.join(datasetPath, "dev_utterances.json"), "utf8")));
  const selected = source.utterances.slice(0, limit);
  const outputDir = path.resolve(flags["--out"] || path.join("work", "evaluations", new Date().toISOString().replace(/[:.]/g, "-")));
  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(outputDir, "dev_subset.json"), JSON.stringify({ meta: { source: "organizer dev_utterances.json", catalogHash: dataset.hash }, utterances: selected }, null, 2));
  const rows: EvaluationRow[] = [];
  const predictions: Record<string, string[]> = {};
  let cursor = 0;
  let estimatedUsd = 0;
  let reservedUsd = 0;
  let saveChain = Promise.resolve();
  const save = () => {
    const snapshot = JSON.stringify(predictions, null, 2);
    saveChain = saveChain.then(() => writeFile(path.join(outputDir, "predictions.json"), snapshot));
    return saveChain;
  };
  const startedAt = new Date().toISOString();
  console.log(`Routing ${selected.length}/${source.utterances.length} organizer utterances; concurrency=${concurrency}; estimated budget=$${maxUsd.toFixed(2)}.`);
  // Reserve $0.05 per in-flight request. This is an application guard, not a billing-enforced cap.
  const worker = async () => {
    while (cursor < selected.length) {
      const utterance = selected[cursor++];
      if (estimatedUsd + reservedUsd + 0.05 > maxUsd + Number.EPSILON) {
        rows.push(score(utterance, undefined, "Estimated evaluation budget reached", true));
        continue;
      }
      reservedUsd += 0.05;
      try {
        // Never pass expected labels, development IDs or fixture answers to the router.
        const result = await routeUtterance({ dataset, state: freshState(), history: [], text: utterance.text });
        const row = score(utterance, result);
        rows.push(row); predictions[utterance.id] = row.predicted; estimatedUsd += result.estimatedUsd;
        console.log(`${utterance.id}: ${row.predicted.join(", ")} | ${row.elapsedMs}ms | $${row.estimatedUsd.toFixed(5)}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Routing failed";
        rows.push(score(utterance, undefined, message)); predictions[utterance.id] = [];
        console.error(`${utterance.id}: routing failed; no retry`);
      } finally { reservedUsd -= 0.05; }
      await save();
    }
  };
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  await save();
  rows.sort((a, b) => selected.findIndex((u) => u.id === a.id) - selected.findIndex((u) => u.id === b.id));
  const summary = metrics(rows);
  const report = {
    startedAt, finishedAt: new Date().toISOString(), model: process.env.ROUTER_MODEL || "gpt-4.1-mini-2025-04-14", catalogHash: dataset.hash,
    businessDate: dataset.businessDate, scope: "development set; text routing only; fresh dialogue for each utterance", selected: selected.length, sourceTotal: source.utterances.length,
    attempted: rows.filter((r) => !r.skipped).length, failures: rows.filter((r) => r.error && !r.skipped).length, skipped: rows.filter((r) => r.skipped).length,
    estimatedUsd, costNote: "Token estimate using configured rates, excluding unknown usage from failed requests; no speech or end-to-end latency claim.", ...summary, rows,
  };
  await writeFile(path.join(outputDir, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ outputDir, estimatedUsd, ...summary }, null, 2));
  if (report.failures || report.skipped) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : "Evaluation failed"); process.exitCode = 1; });
}
