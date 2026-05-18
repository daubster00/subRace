// YouTube channels.list returns subscriberCount rounded to 3 significant
// figures for any channel above 1,000 subscribers (e.g. 5_300_000 and
// 11_200_000 — never 5_312_847). The screen interpolates between polls down
// to the ones digit, but the underlying truth is only known at the rounded
// "API unit" precision, so the displayed value must never wander past the
// half-open bucket [floor, floor + unit) that the latest poll fell into.
//
// Customer-defined units (수정요청사항.docx §2):
//   <  10M  → 10,000      (e.g. 5.30M = [5_300_000, 5_309_999])
//   <  100M → 100,000     (e.g. 11.2M = [11_200_000, 11_299_999])
//   ≥  100M → 1,000,000   (e.g. 123M  = [123_000_000, 123_999_999])

export interface ApiBucket {
  unit: number;
  floor: number;
  ceilExclusive: number;
}

export function getApiUnit(count: number): number {
  if (count < 10_000_000) return 10_000;
  if (count < 100_000_000) return 100_000;
  return 1_000_000;
}

export function getApiBucket(count: number): ApiBucket {
  const safe = Math.max(0, Math.floor(count));
  const unit = getApiUnit(safe);
  const floor = Math.floor(safe / unit) * unit;
  return { unit, floor, ceilExclusive: floor + unit };
}

export function clampToBucket(value: number, bucket: ApiBucket): number {
  const max = bucket.ceilExclusive - 1;
  if (value < bucket.floor) return bucket.floor;
  if (value > max) return max;
  return value;
}
