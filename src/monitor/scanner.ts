import type { Address, PublicClient } from 'viem'
import { PoolAbi } from '../abi.js'
import { log } from '../logger.js'

export interface Candidate {
  user: Address
  healthFactor: bigint // 1e18 scale, < 1e18 => liquidatable
  totalCollateralBase: bigint // USD 8 decimals
  totalDebtBase: bigint
  liquidationThreshold: bigint // bps
}

const HF_SCALE = 10n ** 18n
const BATCH = 100

/**
 * Batched health-factor scan using Multicall3 (viem multicall).
 * Returns users whose HF is below `threshold` (as a float, e.g. 1.05),
 * sorted most-at-risk first.
 */
export async function scanHealth(
  client: PublicClient,
  pool: Address,
  users: Address[],
  threshold: number,
): Promise<Candidate[]> {
  const out: Candidate[] = []
  for (let i = 0; i < users.length; i += BATCH) {
    const batch = users.slice(i, i + BATCH)
    try {
      const results = (await client.multicall({
        allowFailure: true,
        contracts: batch.map((user) => ({
          address: pool,
          abi: PoolAbi,
          functionName: 'getUserAccountData',
          args: [user],
        } as const)),
      })) as Array<{ status: string; result?: unknown }>
      results.forEach((r, idx) => {
        if (r.status !== 'success' || !r.result) return
        const [collateral, totalDebt, , liqThreshold, , hf] = r.result as [
          bigint, bigint, bigint, bigint, bigint, bigint,
        ]
        if (hf < HF_SCALE) {
          out.push({
            user: batch[idx],
            healthFactor: hf,
            totalCollateralBase: collateral,
            totalDebtBase: totalDebt,
            liquidationThreshold: liqThreshold,
          })
        }
      })
    } catch (err) {
      log.warn({ batch: i, err: String(err) }, 'health scan batch failed')
    }
  }
  const t = BigInt(Math.round(threshold * 1e18))
  return out
    .filter((c) => c.healthFactor < t)
    .sort((a, b) => (a.healthFactor < b.healthFactor ? -1 : 1))
}
