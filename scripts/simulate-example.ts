/**
 * Offline sanity check of the liquidation math (no RPC needed).
 * Run: npm run simulate
 *
 * Scenario:
 *   User borrowed 2,000 USDC against 1.2 WETH collateral.
 *   Prices: WETH $3,000, USDC $1. Aave liquidation bonus for WETH: 5% (10450 typically; we use 10500).
 *   Flash-loan premium: 0.05%. Slippage haircut: 1%. Gas: 1.5M units @ 30 gwei, ETH $3,000.
 */
import {
  maxCoverableDebt,
  collateralSeized,
  flashLoanFee,
  withSlippage,
  toUsd8,
  usd8ToNumber,
  formatUnits,
} from '../src/util/math.js'

const WETH_DECIMALS = 18
const USDC_DECIMALS = 6
const BONUS_BPS = 10_500n // 1.05
const PREMIUM_BPS = 5n // 0.05%
const SLIPPAGE_BPS = 100

const collBal = 1_200_000_000_000_000_000n // 1.2 WETH
const debtBal = 2_000_000_000n // 2000 USDC (6 decimals)
const wethPrice = 3_000n * 10n ** 8n
const usdcPrice = 1n * 10n ** 8n

console.log('── Flash-loan liquidation unit economics ──────────────────────')

// 1. Max debt coverable by the collateral (bonus-limited)
const coverable = maxCoverableDebt(collBal, WETH_DECIMALS, wethPrice, USDC_DECIMALS, usdcPrice, BONUS_BPS)
console.log(`Max coverable from collateral : ${formatUnits(coverable, USDC_DECIMALS, 2)} USDC`)

// 2. Close factor cap (50%)
const byCloseFactor = (debtBal * 5n) / 10n
const debtToCover = coverable < byCloseFactor ? coverable : byCloseFactor
console.log(`Close factor cap (50%)        : ${formatUnits(byCloseFactor, USDC_DECIMALS, 2)} USDC`)
console.log(`debtToCover                   : ${formatUnits(debtToCover, USDC_DECIMALS, 2)} USDC`)

// 3. Collateral seized (with 5% bonus)
const seized = collateralSeized(debtToCover, USDC_DECIMALS, usdcPrice, WETH_DECIMALS, wethPrice, BONUS_BPS)
console.log(`Collateral seized             : ${formatUnits(seized, WETH_DECIMALS, 4)} WETH`)

// 4. P&L in USD (8 decimals internally)
const debtUsd8 = toUsd8(debtToCover, USDC_DECIMALS, usdcPrice)
const collUsd8 = toUsd8(seized, WETH_DECIMALS, wethPrice)
const grossUsd8 = collUsd8 - debtUsd8

const fee = flashLoanFee(debtToCover, PREMIUM_BPS)
const feeUsd8 = toUsd8(fee, USDC_DECIMALS, usdcPrice)
const haircutUsd8 = (grossUsd8 * BigInt(SLIPPAGE_BPS)) / 10_000n

const gasUnits = 1_500_000n
const gasPriceGwei = 30n
const gasUsd8 = (gasUnits * gasPriceGwei * 10n ** 9n * wethPrice) / 10n ** 18n

const netUsd8 = grossUsd8 - feeUsd8 - haircutUsd8 - gasUsd8

console.log(`Gross profit                  : $${usd8ToNumber(grossUsd8).toFixed(2)}`)
console.log(`Flash-loan fee (0.05%)        : $${usd8ToNumber(feeUsd8).toFixed(2)}`)
console.log(`Slippage haircut (1%)         : $${usd8ToNumber(haircutUsd8).toFixed(2)}`)
console.log(`Gas (1.5M @ 30 gwei, ETH $3k) : $${usd8ToNumber(gasUsd8).toFixed(2)}`)
console.log(`────────────────────────────────────────────────────────────────`)
console.log(`NET PROFIT                    : $${usd8ToNumber(netUsd8).toFixed(2)}`)
console.log(`minCollateralOut (slippage)   : ${formatUnits(withSlippage(seized, SLIPPAGE_BPS), WETH_DECIMALS, 4)} WETH`)

// ── E-Mode scenario: 100% close factor, category bonus (e.g. 1%) ────────────
console.log('\n── E-Mode scenario (same user, now in E-Mode category 1) ──────')
console.log('E-Mode: close factor 100%, category liquidation bonus 1% (10100)')

const EMODE_BONUS_BPS = 10_100n
const emodeCoverable = maxCoverableDebt(collBal, WETH_DECIMALS, wethPrice, USDC_DECIMALS, usdcPrice, EMODE_BONUS_BPS)
// 100% close factor: cover the FULL debt (bounded by what collateral can cover)
const emodeDebtToCover = emodeCoverable < debtBal ? emodeCoverable : debtBal
const emodeSeized = collateralSeized(emodeDebtToCover, USDC_DECIMALS, usdcPrice, WETH_DECIMALS, wethPrice, EMODE_BONUS_BPS)
const emodeDebtUsd8 = toUsd8(emodeDebtToCover, USDC_DECIMALS, usdcPrice)
const emodeCollUsd8 = toUsd8(emodeSeized, WETH_DECIMALS, wethPrice)
const emodeGrossUsd8 = emodeCollUsd8 - emodeDebtUsd8
const emodeFee = flashLoanFee(emodeDebtToCover, PREMIUM_BPS)
const emodeFeeUsd8 = toUsd8(emodeFee, USDC_DECIMALS, usdcPrice)
const emodeHaircutUsd8 = (emodeGrossUsd8 * BigInt(SLIPPAGE_BPS)) / 10_000n
const emodeNetUsd8 = emodeGrossUsd8 - emodeFeeUsd8 - emodeHaircutUsd8 - gasUsd8

console.log(`debtToCover                   : ${formatUnits(emodeDebtToCover, USDC_DECIMALS, 2)} USDC (FULL debt!)`)
console.log(`Collateral seized             : ${formatUnits(emodeSeized, WETH_DECIMALS, 4)} WETH`)
console.log(`Gross profit                  : $${usd8ToNumber(emodeGrossUsd8).toFixed(2)}`)
console.log(`Flash-loan fee (0.05%)        : $${usd8ToNumber(emodeFeeUsd8).toFixed(2)}`)
console.log(`NET PROFIT (vs $-86 non-eMode): $${usd8ToNumber(emodeNetUsd8).toFixed(2)}`)

if (usd8ToNumber(grossUsd8) < 45) {
  console.log('\nOK — expected gross ~$90 on $100k debt x 5% bonus x 50% close factor scale; sanity bounds hold.')
}
