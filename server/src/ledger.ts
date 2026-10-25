// Money math for verified plays. All amounts are integer micro-dollars (1 USD = 1,000,000).

export const MICROS_PER_CENT = 10_000;

/** Price of `impressions` at a CPM given in cents. */
export function priceImpressions(impressions: number, cpmCents: number): number {
  return Math.round((impressions * cpmCents * MICROS_PER_CENT) / 1000);
}

export interface Split {
  grossMicros: number;
  platformMicros: number;
  venueMicros: number;
  operatorMicros: number;
}

/**
 * Split gross revenue: the platform takes its fee first, the venue gets its revenue share of the
 * remainder, and the operator keeps the rest (including rounding remainders).
 */
export function splitRevenue(grossMicros: number, platformPct: number, venueSharePct: number): Split {
  const platformMicros = Math.floor((grossMicros * platformPct) / 100);
  const net = grossMicros - platformMicros;
  const venueMicros = Math.floor((net * venueSharePct) / 100);
  return { grossMicros, platformMicros, venueMicros, operatorMicros: net - venueMicros };
}

export const microsToUsd = (m: number) => Math.round(m / MICROS_PER_CENT) / 100;
