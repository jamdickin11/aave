/**
 * Unit-conversion helpers for the profitability engine.
 *
 * Conventions:
 *  - Aave oracle prices are USD with 8 decimals (e.g. 3000_00000000 = $3000).
 *  - "usd8" values below are bigint USD amounts scaled by 1e8.
 *  - Liquidation bonus is returned by Aave in 1e4 precision (10500 = 1.05x).
 *  - Flash loan premium is in 1e4 precision (5 = 0.05%).
 */

export const BPS = 10_000n

/** amount * price / 10^decimals -> USD scaled by 1e8 */
export function toUsd8(amount: bigint, decimals: number, price8: bigint): bigint {
  if (amount <= 0n || price8 <= 0n) return 0n
  return (amount * price8) / 10n ** BigInt(decimals)
}

/** USD scaled by 1e8 -> human number */
export function usd8ToNumber(usd8: bigint): number {
  return Number(usd8) / 1e8
}

/** Max debt coverable by `collateralUnits` given the bonus multiplier (1e4). */
export function maxCoverableDebt(
  collateralUnits: bigint,
  collateralDecimals: number,
  collateralPrice8: bigint,
  debtDecimals: number,
  debtPrice8: bigint,
  bonusBps: bigint,
): bigint {
  if (collateralUnits <= 0n) return 0n
  // units = collat * priceC * 1e4 * 10^dD / (10^dC * priceD * bonus)
  const num = collateralUnits * collateralPrice8 * BPS * 10n ** BigInt(debtDecimals)
  const den = 10n ** BigInt(collateralDecimals) * debtPrice8 * bonusBps
  if (den === 0n) return 0n
  return num / den
}

/** Collateral seized when covering `debtUnits`, including the bonus. */
export function collateralSeized(
  debtUnits: bigint,
  debtDecimals: number,
  debtPrice8: bigint,
  collateralDecimals: number,
  collateralPrice8: bigint,
  bonusBps: bigint,
): bigint {
  if (debtUnits <= 0n) return 0n
  // units = debt * priceD * bonus * 10^dC / (10^dD * priceC * 1e4)
  const num = debtUnits * debtPrice8 * bonusBps * 10n ** BigInt(collateralDecimals)
  const den = 10n ** BigInt(debtDecimals) * collateralPrice8 * BPS
  if (den === 0n) return 0n
  return num / den
}

/** Flash-loan fee for borrowing `amount` (premium in 1e4 precision, e.g. 5 = 0.05%). */
export function flashLoanFee(amount: bigint, premiumBps: bigint): bigint {
  return (amount * premiumBps) / BPS
}

/** Apply slippage haircut (bps) to a min-out amount. */
export function withSlippage(amount: bigint, slippageBps: number): bigint {
  const bps = BigInt(Math.max(0, Math.min(5000, slippageBps)))
  return (amount * (BPS - bps)) / BPS
}

/** Bigint -> number without precision catastrophes for display. */
export function formatUnits(value: bigint, decimals: number, precision = 4): string {
  const n = Number(value) / 10 ** decimals
  return n.toLocaleString('en-US', { maximumFractionDigits: precision })
}
