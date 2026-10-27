import type { Address, PublicClient } from 'viem'
import { PoolAbi, AaveOracleAbi, Erc20Abi, UniswapV2RouterAbi, QuoterV2Abi } from '../abi.js'
import type { ReserveCache, ReserveInfo } from './reserves.js'
import type { Candidate } from '../monitor/scanner.js'
import type { SwapBackend } from '../config.js'
import {
  collateralSeized,
  flashLoanFee,
  withSlippage,
  toUsd8,
  usd8ToNumber,
} from '../util/math.js'
import { log } from '../logger.js'

export type SwapBackendUsed = 'none' | 'v2' | 'v3'

export interface SwapRoute {
  backend: SwapBackendUsed
  router: Address // unused when backend = none
  fee: number // V3 pool fee tier (100/500/3000/10000); 0 for V2 and 'none'
  expectedOut: bigint // quoted debt-asset units received for the seized collateral
  minOut: bigint // slippage-protected minimum enforced on-chain
}

export interface Opportunity {
  user: Address
  collateral: ReserveInfo
  debt: ReserveInfo
  eModeActive: boolean
  debtToCover: bigint // debt-asset units (flash-loan amount)
  collateralSeizedUnits: bigint // expected aTokens at execution
  route: SwapRoute
  healthFactor: bigint
  grossUsd: number
  flashFeeUsd: number
  swapHaircutUsd: number
  gasUsd: number
  netUsd: number
}

const BPS = 10_000n
const CLOSE_FACTOR_HALF: [bigint, bigint] = [5n, 10n] // 50% — default outside E-Mode
const CLOSE_FACTOR_FULL: [bigint, bigint] = [10n, 10n] // 100% — E-Mode positions
const V3_FEE_TIERS = [100, 500, 3000, 10000]

export interface EngineDeps {
  client: PublicClient
  pool: Address
  oracle: Address
  weth: Address
  flashPremiumBps: bigint // e.g. 5n = 0.05% on Aave v3
  slippageBps: number
  gasUnits: bigint
  swapBackend: SwapBackend
  uniswapV2Router: Address
  swapRouter02: Address
  quoterV2: Address
}

interface Quote {
  backend: 'v2' | 'v3'
  fee: number
  out: bigint
}

/**
 * Profitability engine (v2).
 *
 * For a candidate user with HF < 1:
 *  1. Read their collateral/borrow configuration bitmap -> which reserves they use.
 *  2. Read E-Mode: if the user is in category X and the collateral reserve is in
 *     the same category, Aave applies a 100% close factor and the CATEGORY's
 *     liquidation bonus (instead of 50% and the reserve's bonus).
 *  3. Read aToken & variable-debt balances + oracle prices.
 *  4. For every (collateral, debt) pair compute debtToCover, then get REAL DEX
 *     quotes for swapping the seized collateral back to the debt asset
 *     (V2 pair vs V3 fee tiers, `auto` picks the better one).
 *  5. Net profit = swap output - debt repaid - flash fee - slippage haircut - gas.
 *
 * Returns the single best pair (or null if nothing is profitable/possible).
 */
export class LiquidationEngine {
  private reserveCache!: ReserveCache
  private eModeBonus = new Map<number, bigint>()

  constructor(private deps: EngineDeps) {}

  setCache(cache: ReserveCache): void {
    this.reserveCache = cache
  }

  private async prices(assets: Address[]): Promise<Map<Address, bigint>> {
    const results = (await this.deps.client.multicall({
      allowFailure: false,
      contracts: assets.map((asset) => ({
        address: this.deps.oracle,
        abi: AaveOracleAbi,
        functionName: 'getAssetPrice',
        args: [asset],
      } as const)),
    })) as bigint[]
    const map = new Map<Address, bigint>()
    assets.forEach((a, i) => map.set(a, results[i]))
    return map
  }

  /** E-Mode category of the user (0 = not in E-Mode). */
  private async userEMode(user: Address): Promise<number> {
    try {
      const cat = (await this.deps.client.readContract({
        address: this.deps.pool,
        abi: PoolAbi,
        functionName: 'getUserEMode',
        args: [user],
      })) as number
      return Number(cat)
    } catch {
      return 0
    }
  }

  /** Category liquidation bonus (1e4 scale), cached. */
  private async eModeBonusBps(category: number): Promise<bigint> {
    const hit = this.eModeBonus.get(category)
    if (hit !== undefined) return hit
    try {
      const data = (await this.deps.client.readContract({
        address: this.deps.pool,
        abi: PoolAbi,
        functionName: 'getEModeCategoryData',
        args: [category],
      })) as [number, number, number, Address]
      const bonus = BigInt(data[2])
      this.eModeBonus.set(category, bonus)
      return bonus
    } catch {
      return 10_000n // 0% bonus fallback — will simply look unprofitable
    }
  }

  /** Which reserves the user uses as collateral / has variable debt in. */
  private async userReserves(user: Address): Promise<{
    collateralAssets: Address[]
    debtAssets: Address[]
  }> {
    const client = this.deps.client
    const [config, reserves] = await Promise.all([
      client.readContract({
        address: this.deps.pool,
        abi: PoolAbi,
        functionName: 'getUserConfiguration',
        args: [user],
      }) as Promise<[bigint, bigint]>,
      this.reserveCache.reservesList(),
    ])

    const [collBitmap, borrowBitmap] = config
    const collateralAssets: Address[] = []
    const debtAssets: Address[] = []
    reserves.forEach((asset: Address, i: number) => {
      const bit = 1n << BigInt(i)
      if ((collBitmap & bit) !== 0n) collateralAssets.push(asset)
      if ((borrowBitmap & bit) !== 0n) debtAssets.push(asset)
    })
    return { collateralAssets, debtAssets }
  }

  /**
   * Real swap quotes: V2 pair and/or best V3 fee tier.
   * Returns null when no route can convert collateral -> debt asset.
   */
  private async selectRoute(
    collateralAsset: Address,
    debtAsset: Address,
    seizedUnits: bigint,
  ): Promise<SwapRoute | null> {
    if (collateralAsset === debtAsset) {
      // No swap needed — collateral IS the flash-loan asset.
      const out = seizedUnits
      return { backend: 'none', router: this.deps.uniswapV2Router, fee: 0, expectedOut: out, minOut: withSlippage(out, this.deps.slippageBps) }
    }

    const quotes: Quote[] = []
    const jobs: Array<Promise<void>> = []

    if (this.deps.swapBackend !== 'v3') {
      jobs.push(
        (async () => {
          try {
            const amounts = (await this.deps.client.readContract({
              address: this.deps.uniswapV2Router,
              abi: UniswapV2RouterAbi,
              functionName: 'getAmountsOut',
              args: [seizedUnits, [collateralAsset, debtAsset]],
            })) as bigint[]
            if (amounts.length === 2 && amounts[1] > 0n) {
              quotes.push({ backend: 'v2', fee: 0, out: amounts[1] })
            }
          } catch {
            /* no V2 pair — fine */
          }
        })(),
      )
    }

    const hasQuoter =
      this.deps.swapBackend !== 'v2' &&
      this.deps.quoterV2.toLowerCase() !== '0x0000000000000000000000000000000000000000'

    if (hasQuoter) {
      jobs.push(
        (async () => {
          try {
            const results = (await this.deps.client.multicall({
              allowFailure: true,
              contracts: V3_FEE_TIERS.map((fee) => ({
                address: this.deps.quoterV2,
                abi: QuoterV2Abi,
                functionName: 'quoteExactInputSingle',
                args: [
                  {
                    tokenIn: collateralAsset,
                    tokenOut: debtAsset,
                    amountIn: seizedUnits,
                    fee,
                    sqrtPriceLimitX96: 0n,
                  },
                ],
              } as const)),
            })) as Array<{ status: string; result?: unknown }>
            results.forEach((r, i) => {
              if (r.status === 'success' && r.result) {
                const out = (r.result as bigint[])[0]
                if (out > 0n) quotes.push({ backend: 'v3', fee: V3_FEE_TIERS[i], out })
              }
            })
          } catch {
            /* quoter unavailable — fine */
          }
        })(),
      )
    }

    await Promise.all(jobs)
    if (quotes.length === 0) return null

    quotes.sort((a, b) => (b.out > a.out ? 1 : b.out < a.out ? -1 : 0))
    const best = quotes[0]
    const router = best.backend === 'v2' ? this.deps.uniswapV2Router : this.deps.swapRouter02
    return {
      backend: best.backend,
      router,
      fee: best.fee,
      expectedOut: best.out,
      minOut: withSlippage(best.out, this.deps.slippageBps),
    }
  }

  async buildOpportunity(candidate: Candidate): Promise<Opportunity | null> {
    try {
      return await this._build(candidate)
    } catch (err) {
      log.warn({ user: candidate.user, err: String(err) }, 'opportunity build failed')
      return null
    }
  }

  private async _build(candidate: Candidate): Promise<Opportunity | null> {
    const client = this.deps.client
    const [{ collateralAssets, debtAssets }, eModeCategory] = await Promise.all([
      this.userReserves(candidate.user),
      this.userEMode(candidate.user),
    ])
    if (collateralAssets.length === 0 || debtAssets.length === 0) return null

    const collInfo = await Promise.all(collateralAssets.map((a) => this.reserveCache.get(a)))
    const debtInfo = await Promise.all(debtAssets.map((a) => this.reserveCache.get(a)))

    // Balances: aTokens (collateral) and variable debt tokens
    const balanceCalls = [
      ...collInfo.map((r) => ({
        address: r.aToken,
        abi: Erc20Abi,
        functionName: 'balanceOf' as const,
        args: [candidate.user] as const,
      })),
      ...debtInfo.map((r) => ({
        address: r.variableDebtToken,
        abi: Erc20Abi,
        functionName: 'balanceOf' as const,
        args: [candidate.user] as const,
      })),
    ]
    const balances = (await client.multicall({ allowFailure: false, contracts: balanceCalls })) as bigint[]
    const collBalances = balances.slice(0, collInfo.length)
    const debtBalances = balances.slice(collInfo.length)

    const allAssets = [...collateralAssets, ...debtAssets]
    const priceMap = await this.prices(allAssets)
    const ethPrice8 = priceMap.get(this.deps.weth) ?? 0n

    // Gas cost estimate in USD (8 decimals)
    const feeData = await client.estimateFeesPerGas().catch(() => null)
    let maxFeePerGas = feeData?.maxFeePerGas
    if (!maxFeePerGas) maxFeePerGas = await client.getGasPrice()
    const gasWei = this.deps.gasUnits * maxFeePerGas
    const gasUsd8 = ethPrice8 > 0n ? (gasWei * ethPrice8) / 10n ** 18n : 0n

    let best: Opportunity | null = null

    for (let d = 0; d < debtInfo.length; d++) {
      const debtRes = debtInfo[d]
      const debtBal = debtBalances[d]
      if (debtBal <= 0n) continue
      const debtPrice = priceMap.get(debtRes.asset) ?? 0n
      if (debtPrice <= 0n) continue

      for (let c = 0; c < collInfo.length; c++) {
        const collRes = collInfo[c]
        const collBal = collBalances[c]
        if (collBal <= 0n) continue
        const collPrice = priceMap.get(collRes.asset) ?? 0n
        if (collPrice <= 0n) continue

        // ── E-Mode logic ────────────────────────────────────────────────────
        const eModeActive = eModeCategory !== 0 && collRes.eModeCategory === eModeCategory
        const [cfNum, cfDen] = eModeActive ? CLOSE_FACTOR_FULL : CLOSE_FACTOR_HALF
        const bonusBps = eModeActive
          ? await this.eModeBonusBps(eModeCategory)
          : collRes.liquidationBonusBps

        // Max debt coverable by this collateral at this bonus
        const coverable =
          collBal > 0n
            ? (collBal * collPrice * BPS * 10n ** BigInt(debtRes.decimals)) /
              (10n ** BigInt(collRes.decimals) * debtPrice * bonusBps)
            : 0n
        const byCloseFactor = (debtBal * cfNum) / cfDen
        const debtToCover = coverable < byCloseFactor ? coverable : byCloseFactor
        if (debtToCover <= 0n) continue

        const seized = collateralSeized(
          debtToCover,
          debtRes.decimals,
          debtPrice,
          collRes.decimals,
          collPrice,
          bonusBps,
        )
        if (seized > collBal) continue // conservative guard: never expect more than the balance
        if (seized === 0n) continue

        // ── Route selection (real quotes) ───────────────────────────────────
        const route = await this.selectRoute(collRes.asset, debtRes.asset, seized)
        if (!route) continue // cannot convert collateral -> debt: skip pair

        // ── P&L: everything lands in debt-asset units ──────────────────────
        const debtRepaidUsd8 = toUsd8(debtToCover, debtRes.decimals, debtPrice)
        const outUsd8 = toUsd8(route.expectedOut, debtRes.decimals, debtPrice)
        const grossUsd8 = outUsd8 > debtRepaidUsd8 ? outUsd8 - debtRepaidUsd8 : 0n
        if (grossUsd8 === 0n) continue

        const fee = flashLoanFee(debtToCover, this.deps.flashPremiumBps)
        const feeUsd8 = toUsd8(fee, debtRes.decimals, debtPrice)
        const haircutUsd8 = (grossUsd8 * BigInt(this.deps.slippageBps)) / BPS
        const netUsd8 =
          grossUsd8 > feeUsd8 + haircutUsd8 + gasUsd8
            ? grossUsd8 - feeUsd8 - haircutUsd8 - gasUsd8
            : 0n

        const opp: Opportunity = {
          user: candidate.user,
          collateral: collRes,
          debt: debtRes,
          eModeActive,
          debtToCover,
          collateralSeizedUnits: seized,
          route,
          healthFactor: candidate.healthFactor,
          grossUsd: usd8ToNumber(grossUsd8),
          flashFeeUsd: usd8ToNumber(feeUsd8),
          swapHaircutUsd: usd8ToNumber(haircutUsd8),
          gasUsd: usd8ToNumber(gasUsd8),
          netUsd: usd8ToNumber(netUsd8),
        }

        if (!best || opp.netUsd > best.netUsd) best = opp
      }
    }

    return best
  }
}
