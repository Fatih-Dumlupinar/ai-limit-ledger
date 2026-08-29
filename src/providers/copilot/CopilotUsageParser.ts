import type {
  CopilotUsageItem,
  CopilotUsageResponse,
  CopilotUsageSummary,
  CopilotModelBreakdown,
} from './types';

export function nextCopilotResetAt(now: Date): number {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
}

export function parseCopilotUsage(
  response: CopilotUsageResponse,
  now: Date = new Date(),
): CopilotUsageSummary {
  let usedCredits = 0;
  let includedCredits = 0;
  let hasIncluded = false;
  let cost = 0;
  let hasCost = false;
  const byModel = new Map<string, { quantity: number; cost: number | null }>();
  for (const item of response.usageItems) {
    const quantity = item.netQuantity ?? item.grossQuantity;
    if (quantity !== null && Number.isFinite(quantity) && quantity >= 0) {
      usedCredits += quantity;
      const model = item.model ?? item.sku ?? item.product ?? 'Unknown model';
      const existing = byModel.get(model) ?? { quantity: 0, cost: null };
      existing.quantity += quantity;
      byModel.set(model, existing);
    }
    if (
      item.discountQuantity !== null &&
      Number.isFinite(item.discountQuantity) &&
      item.discountQuantity >= 0
    ) {
      includedCredits += item.discountQuantity;
      hasIncluded = true;
    }
    const amount = item.netAmount ?? item.grossAmount;
    if (amount !== null && Number.isFinite(amount) && amount >= 0) {
      cost += amount;
      hasCost = true;
      const model = item.model ?? item.sku ?? item.product ?? 'Unknown model';
      const existing = byModel.get(model) ?? { quantity: 0, cost: null };
      existing.cost = (existing.cost ?? 0) + amount;
      byModel.set(model, existing);
    }
  }
  const included = hasIncluded ? includedCredits : null;
  const additional = hasIncluded ? Math.max(usedCredits - includedCredits, 0) : null;
  const modelBreakdown: CopilotModelBreakdown[] = [...byModel.entries()].map(([model, value]) => ({
    model,
    quantity: value.quantity,
    cost: value.cost,
  }));
  return {
    timePeriod: response.timePeriod,
    usedCredits,
    includedCredits: included,
    additionalCredits: additional,
    cost: hasCost ? cost : null,
    modelBreakdown,
    nextResetAt: nextCopilotResetAt(now),
    credits: {
      used: usedCredits,
      included,
      additional,
      cost: hasCost ? cost : null,
      currency: 'USD',
    },
  };
}

export function copilotItemIsCredit(item: CopilotUsageItem): boolean {
  return item.unitType === null || /credit/i.test(item.unitType);
}
