import { keccak256, toHex, type Address } from 'viem'
import type { PublicClient } from 'viem'
import { PoolAbi } from './abi.js'

/**
 * Per-chain base registry.
 *
 * DESIGN NOTE (v2): only the POOL address is the anchor. Everything else is
 * resolved dynamically:
 *   pool.ADDRESSES_PROVIDER()  ->  provider.getAddress(PRICE_ORACLE / POOL_DATA_PROVIDER)
 * This minimizes hardcoded addresses (the #1 source of silent fund loss in bots).
 *
 * Still verify each Pool address against an explorer before mainnet runs:
 *   - Ethereum:  0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2   (verified, Aave docs)
 *   - Sepolia:   0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951   (verified)
 *   - Base:      0xA238Dd80C259a72e81d7e4664a9801593F98d1c5   (verified via Basescan "Aave: Pool Proxy")
 *   - Arbitrum:  0x794a61358D6845594F94dc1DB02A252b5b4814aD   (verified via Arbiscan "Aave: Pool V3")
 *
 * Swap infrastructure (verified Oct 2025 against docs.uniswap.org + explorers):
 *   - V2 Router02 mainnet:      0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D (verified)
 *   - V2 Router02 Base/Arbitrum: 0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24
 *     (Basescan + Arbiscan name-tag "Uniswap: V2 Router02")
 *   - SwapRouter02 mainnet+Arbitrum: 0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45
 *   - SwapRouter02 Base:        0x2626664c2603336E57B271c5C0b26F421741e481
 *     (official Base deployments table — note it differs from other chains!)
 *   - QuoterV2 mainnet+Arbitrum: 0x61fFE014bA17989E743c5F6cB21bF9697530B21e
 *   - QuoterV2 Base:            0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a
 *   - Sepolia: routers/quoter kept unverified (testnet); QuoterV2 = 0 disables
 *     V3 quoting there (auto mode falls back to V2 quotes).
 *   Always re-check before mainnet runs: https://developers.uniswap.org/docs/protocols/v3/deployments
 */

export interface BaseRegistry {
  pool: Address
  providerFallback: Address // used only if pool.ADDRESSES_PROVIDER() call fails
  multicall: Address // Multicall3 — deterministic deploy, same address everywhere
  weth: Address
  uniswapV2Router: Address
  swapRouter02: Address // Uniswap SwapRouter02 (handles V3 pools without callbacks)
  quoterV2: Address // zero address = V3 quoting disabled on this chain
  routerVerified: boolean
}

const ZERO = '0x0000000000000000000000000000000000000000' as Address

export const REGISTRIES: Record<string, BaseRegistry> = {
  mainnet: {
    pool: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2',
    providerFallback: '0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e',
    multicall: '0xcA11bde05977b3631167028862bE2a173976CA11',
    weth: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    uniswapV2Router: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D',
    swapRouter02: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
    quoterV2: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
    routerVerified: true,
  },
  // Sepolia — safe end-to-end testing before touching real funds
  sepolia: {
    pool: '0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951',
    providerFallback: '0x012bAC54348C0E635dCAc9D5fbBfDC0612F049eC', // VERIFY
    multicall: '0xcA11bde05977b3631167028862bE2a173976CA11',
    weth: '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14',
    uniswapV2Router: '0xeE567Fe1712Faf6149d80dA1E6934E354124CfE3c', // VERIFY
    swapRouter02: '0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E', // VERIFY
    quoterV2: ZERO, // V3 quoting disabled until you set QUOTER_V2
    routerVerified: false,
  },
  // Base — Aave v3 with far less bot competition than mainnet
  base: {
    pool: '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5', // verified (Basescan)
    providerFallback: ZERO, // resolved from pool.ADDRESSES_PROVIDER()
    multicall: '0xcA11bde05977b3631167028862bE2a173976CA11',
    weth: '0x4200000000000000000000000000000000000006', // verified (canonical Base WETH)
    uniswapV2Router: '0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24', // verified (Basescan "Uniswap: V2 Router02")
    swapRouter02: '0x2626664c2603336E57B271c5C0b26F421741e481', // verified (official Base deployments table — NOT ...48E)
    quoterV2: '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a', // verified (official Base deployments table)
    routerVerified: true,
  },
  // Arbitrum One — deepest L2 lending market
  arbitrum: {
    pool: '0x794a61358D6845594F94dc1DB02A252b5b4814aD', // verified (Arbiscan)
    providerFallback: '0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb', // cross-check
    multicall: '0xcA11bde05977b3631167028862bE2a173976CA11',
    weth: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', // verified (canonical Arbitrum WETH)
    uniswapV2Router: '0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24', // verified (Arbiscan "Uniswap V2: Router")
    swapRouter02: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45', // verified (official Arbitrum deployments — same as mainnet)
    quoterV2: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e', // verified (official Arbitrum deployments — same as mainnet)
    routerVerified: true,
  },
}

export interface AddressBook {
  pool: Address
  provider: Address
  oracle: Address
  dataProvider: Address
  multicall: Address
  weth: Address
  uniswapV2Router: Address
  swapRouter02: Address
  quoterV2: Address
  routerVerified: boolean
}

const id = (s: string) => keccak256(toHex(s))

/**
 * Anchor Pool address for a chain, honoring the AAVE_POOL env override.
 * Used by scripts/deploy.ts (constructor arg) and baseRegistry() below.
 */
export function poolAddressFor(chainName: string): Address {
  const r = REGISTRIES[chainName]
  if (!r) {
    throw new Error(
      `Unknown chain "${chainName}". Known: ${Object.keys(REGISTRIES).join(', ')}.`,
    )
  }
  return ((process.env.AAVE_POOL as Address | undefined) || r.pool)
}

function baseRegistry(chainName: string): BaseRegistry {
  const r = REGISTRIES[chainName]
  if (!r) {
    throw new Error(
      `Unknown chain "${chainName}". Known: ${Object.keys(REGISTRIES).join(', ')}. ` +
        `Add a new entry in src/chains.ts to support another network.`,
    )
  }
  const override = (env: string, fallback: Address): Address =>
    ((process.env[env] as Address | undefined) || fallback)

  return {
    pool: override('AAVE_POOL', r.pool),
    providerFallback: override('AAVE_ADDRESSES_PROVIDER', r.providerFallback),
    multicall: override('MULTICALL3', r.multicall),
    weth: override('WETH', r.weth),
    uniswapV2Router: override('UNISWAP_V2_ROUTER', r.uniswapV2Router),
    swapRouter02: override('SWAP_ROUTER02', r.swapRouter02),
    quoterV2: override('QUOTER_V2', r.quoterV2),
    routerVerified: r.routerVerified,
  }
}

const PROVIDER_ABI = [
  {
    name: 'getAddress',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'id', type: 'bytes32' }],
    outputs: [{ type: 'address' }],
  },
] as const

const isZero = (a: Address) => a.toLowerCase() === ZERO

/**
 * Resolve the full address book:
 *   1. pool (registry/env)
 *   2. provider = pool.ADDRESSES_PROVIDER()  [fallback: registry/env]
 *   3. oracle + dataProvider = provider.getAddress(id)
 */
export async function resolveAddressBook(
  client: PublicClient,
  chainName: string,
): Promise<AddressBook> {
  const base = baseRegistry(chainName)

  // 2. provider — from the pool itself (authoritative), registry only as fallback
  let provider = base.providerFallback
  try {
    const fromPool = (await client.readContract({
      address: base.pool,
      abi: PoolAbi,
      functionName: 'ADDRESSES_PROVIDER',
    })) as Address
    if (!isZero(fromPool)) provider = fromPool
  } catch {
    // fall back to registry entry below
  }

  // 3. oracle + data provider
  let oracle: Address | undefined
  let dataProvider: Address | undefined
  if (!isZero(provider)) {
    try {
      const results = await client.multicall({
        allowFailure: false,
        contracts: [
          { address: provider, abi: PROVIDER_ABI, functionName: 'getAddress', args: [id('PRICE_ORACLE')] },
          { address: provider, abi: PROVIDER_ABI, functionName: 'getAddress', args: [id('POOL_DATA_PROVIDER')] },
        ] as const,
      })
      oracle = results[0] as Address
      dataProvider = results[1] as Address
    } catch {
      // handled below
    }
  }

  if (!oracle || isZero(oracle)) {
    throw new Error(
      'Could not resolve Aave price oracle. Set AAVE_ORACLE in .env (verify address from official docs).',
    )
  }
  if (!dataProvider || isZero(dataProvider)) {
    throw new Error(
      'Could not resolve AaveProtocolDataProvider. Set AAVE_DATA_PROVIDER in .env.',
    )
  }

  return {
    pool: base.pool,
    provider,
    oracle,
    dataProvider,
    multicall: base.multicall,
    weth: base.weth,
    uniswapV2Router: base.uniswapV2Router,
    swapRouter02: base.swapRouter02,
    quoterV2: base.quoterV2,
    routerVerified: base.routerVerified,
  }
}
