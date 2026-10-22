// Prisregler for kontingent: forholdsmæssig første periode og rabatter. Alle beløb er i øre og sættes af foreningen selv;
// HoldLiv fastsætter ingen priser eller procenter.


export interface PriceInput {
  amountOre: number;
  period: { start: string; end: string };
  /** Dato (ÅÅÅÅ-MM-DD) medlemmet blev indmeldt. */
  joinedOn: string;
  prorate: boolean;
  siblingDiscountPercent: number;
  /** 0 for den ældste (eller enlige) i familien, 1 for næste osv. */
  siblingRank: number;
  memberDiscountPercent: number;
}

export interface Price {
  amountOre: number;
  notes: string[];
}

const dayCount = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1;

export function priceCharge(i: PriceInput): Price {
  const notes: string[] = [];
  let amount = i.amountOre;
  if (i.prorate && i.joinedOn > i.period.start && i.joinedOn <= i.period.end) {
    const total = dayCount(i.period.start, i.period.end);
    const left = dayCount(i.joinedOn, i.period.end);
    amount = Math.round((i.amountOre * left) / total);
    notes.push(`forholdsmæssigt: ${left} af ${total} dage`);
  }
  const sibling = i.siblingRank > 0 ? i.siblingDiscountPercent : 0;
  const pct = Math.max(sibling, i.memberDiscountPercent);
  if (pct > 0) {
    amount = Math.round((amount * (100 - pct)) / 100);
    notes.push(sibling >= i.memberDiscountPercent ? `søskenderabat ${pct} %` : `rabat ${pct} %`);
  }
  return { amountOre: amount, notes };
}

