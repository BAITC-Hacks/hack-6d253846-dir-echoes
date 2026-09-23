import { importDataset } from "../src/lib/dataset";
async function main() {
  const directory = process.env.DATASET_PATH || process.argv[2];
  if (!directory) throw new Error("Set DATASET_PATH to the organizer's extracted directory.");
  console.log(JSON.stringify(await importDataset(directory), null, 2));
}
main().then(() => process.exit(0)).catch(error => { console.error(error.message); process.exit(1); });
