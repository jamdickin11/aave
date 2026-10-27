import type { Address, PublicClient } from 'viem'
import { DataProviderAbi, PoolAbi } from '../abi.js'
import { log } from '../logger.js'

export interface ReserveInfo {
  asset: Address
  aToken: Address
  variableDebtToken: Address
  decimals: number
  liquidationBonusBps: bigint // 1e4 scale: 10500 = 1.05x
  liquidationThresholdBps: bigint
  eModeCategory: number // 0 = none; >0 = reserve belongs to this E-Mode category
}

const CONFIG_TTL_MS = 24 * 60 * 60 * 1000
const RESERVES_TTL_MS = 60 * 60 * 1000

/**
 * Caches per-reserve configuration (bonus, decimals, token addresses).
 * These are effectively static; refreshing daily is plenty.
 */
export class ReserveCache {
  private info = new Map<Address, { at: number; value: ReserveInfo }>()
  private reservesListCache: { at: number; value: Address[] } | null = null

  constructor(
    private client: PublicClient,
    private pool: Address,
    private dataProvider: Address,
  ) {}

  async reservesList(): Promise<Address[]> {
    if (this.reservesListCache && Date.now() - this.reservesListCache.at < RESERVES_TTL_MS) {
      return this.reservesListCache.value
    }
    const value = (await this.client.readContract({
      address: this.pool,
      abi: [{ name: 'getReservesList', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address[]' }] }] as const,
      functionName: 'getReservesList',
    })) as Address[]
    this.reservesListCache = { at: Date.now(), value }
    return value
  }

  async get(asset: Address): Promise<ReserveInfo> {
    const hit = this.info.get(asset)
    if (hit && Date.now() - hit.at < CONFIG_TTL_MS) return hit.value

    const [tokens, config, poolData] = await Promise.all([
      this.client.readContract({
        address: this.dataProvider,
        abi: DataProviderAbi,
        functionName: 'getReserveTokensAddresses',
        args: [asset],
      }),
      this.client.readContract({
        address: this.dataProvider,
        abi: DataProviderAbi,
        functionName: 'getReserveConfigurationData',
        args: [asset],
      }),
      this.client.readContract({
        address: this.pool,
        abi: PoolAbi,
        functionName: 'getReserveData',
        args: [asset],
      }) as unknown as Promise<[bigint]>,
    ])

    // Decode E-Mode category from the reserve configuration bitmap (bits 80..87).
    const configuration = poolData[0]
    const eModeCategory = Number((configuration >> 80n) & 0xffn)

    const [aToken, , variableDebtToken] = tokens
    const [decimals, , liquidationThreshold, liquidationBonus] = config

    const value: ReserveInfo = {
      asset,
      aToken,
      variableDebtToken,
      decimals: Number(decimals),
      liquidationBonusBps: liquidationBonus,
      liquidationThresholdBps: liquidationThreshold,
      eModeCategory,
    }
    this.info.set(asset, { at: Date.now(), value })
    log.debug(
      { asset, decimals: value.decimals, bonus: String(liquidationBonus), eModeCategory },
      'reserve config cached',
    )
    return value
  }

  async getMany(assets: Address[]): Promise<ReserveInfo[]> {
    return Promise.all(assets.map((a) => this.get(a)))
  }
}
