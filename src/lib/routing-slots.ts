import type { Dataset, SlotDefinition } from "./types";

// Runtime parameters already consumed by the executor. Their allowed values come
// from the supplied knowledge base, but they are absent from its 43 source slots.
// Keep the imported dataset and its provenance/hash unchanged.
const runtimeSlots: SlotDefinition[] = [
  {
    name: "package",
    type: "enum",
    description: "CASCO program for SC03 only; Standard or Lite, as defined in products.casco.pricing.package_coef. Extract only an explicitly chosen program.",
    values: ["Standard", "Lite"],
    prompt: {
      ru: "Какую программу КАСКО выбираете: Standard или Lite?",
      kk: "Қай КАСКО бағдарламасын таңдайсыз: Standard немесе Lite?",
    },
  },
  {
    name: "term_months",
    type: "integer",
    description: "OGPO term in months for SC01 or SC02 only; 6 or 12, as defined in products.ogpo.pricing.term_coef. Extract only an explicitly chosen duration.",
    values: [6, 12],
    prompt: {
      ru: "На какой срок нужен полис ОГПО: шесть или двенадцать месяцев?",
      kk: "ОГПО полисі қанша мерзімге қажет: алты немесе он екі айға?",
    },
  },
];

export function effectiveSlots(dataset: Dataset): SlotDefinition[] {
  const sourceNames = new Set(dataset.slots.map(slot => slot.name));
  return [...dataset.slots, ...runtimeSlots.filter(slot => !sourceNames.has(slot.name))];
}
