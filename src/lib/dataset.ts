import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { query, transaction } from "./db";
import type { Dataset, JsonObject } from "./types";

export async function loadDatasetFromPath(directory: string): Promise<Dataset> {
  const names = ["scenarios", "slots", "actions", "knowledge_base", "mock_backend"];
  const hash = createHash("sha256");
  const files: Record<string, Record<string, unknown>> = {};
  for (const name of names) { const source = await readFile(path.join(directory, name + ".json"), "utf8"); hash.update(name).update(source); files[name] = JSON.parse(source); }
  const meta = files.scenarios.meta as { version: string; as_of_date: string };
  const dataset: Dataset = {
    version: meta.version, businessDate: meta.as_of_date, hash: hash.digest("hex"),
    scenarios: files.scenarios.scenarios as Dataset["scenarios"], systemIntents: files.scenarios.system_intents as JsonObject[],
    slots: files.slots.slots as Dataset["slots"], actions: files.actions.actions as Dataset["actions"],
    queues: files.actions.queues as string[], knowledge: files.knowledge_base as JsonObject, backend: files.mock_backend as JsonObject
  };
  if (dataset.scenarios.length !== 40 || dataset.slots.length !== 43 || dataset.actions.length !== 31) throw new Error("Dataset does not match organizer catalog (40 scenarios, 43 slots, 31 actions).");
  const actionIds = new Set(dataset.actions.map(a => a.name));
  const slotIds = new Set(dataset.slots.map(a => a.name));
  for (const scenario of dataset.scenarios) {
    if (scenario.actions.some(id => !actionIds.has(id)) || [...scenario.slots.required, ...scenario.slots.optional].some(id => !slotIds.has(id))) throw new Error("Dataset contains unresolved references.");
  }
  return dataset;
}
export async function importDataset(directory: string) {
  const dataset = await loadDatasetFromPath(directory);
  await transaction(async sql => {
    const existing = await sql.query<{ hash: string }>("SELECT hash FROM dataset_versions WHERE id='current'");
    if (existing.rows[0] && existing.rows[0].hash !== dataset.hash) throw new Error("A different dataset is already imported. Migrate explicitly to preserve existing records.");
    await sql.query("INSERT INTO dataset_versions(id,hash,data) VALUES('current',$1,$2::jsonb) ON CONFLICT(id) DO NOTHING", [dataset.hash, JSON.stringify(dataset)]);
    const persisted = await sql.query<{hash:string}>("SELECT hash FROM dataset_versions WHERE id='current' FOR UPDATE");
    if(persisted.rows[0]?.hash!==dataset.hash) throw new Error("Concurrent import selected a different dataset. No records were changed.");
    const keys: Record<string,string> = { clients: "client_id", policies: "policy_number", claims: "claim_number", payments: "payment_id" };
    for (const [kind, key] of Object.entries(keys)) {
      for (const entity of dataset.backend[kind] as JsonObject[]) {
        const id = entity[key]; if (typeof id !== "string") throw new Error(`Missing identifier for ${kind}`);
        await sql.query("INSERT INTO entities(kind,id,data) VALUES($1,$2,$3::jsonb) ON CONFLICT(kind,id) DO NOTHING", [kind, id, JSON.stringify(entity)]);
      }
    }
  });
  cachedDataset = dataset;
  return { hash: dataset.hash, scenarios: dataset.scenarios.length, businessDate: dataset.businessDate };
}
let cachedDataset: Dataset | undefined;
export async function getDataset(): Promise<Dataset> {
  if (cachedDataset) return cachedDataset;
  const result = await query<{ data: Dataset }>("SELECT data FROM dataset_versions WHERE id='current'");
  if (!result.rows[0]) throw new Error("DATASET_NOT_IMPORTED: run the documented dataset import.");
  cachedDataset = result.rows[0].data; return cachedDataset;
}
