import 'dotenv/config'
import { http, webSocket, createPublicClient, createWalletClient, type Chain, type PublicClient, type WalletClient } from 'viem'
import { mainnet, sepolia, base, arbitrum } from 'viem/chains'
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts'

export type ExecutionMode = 'dry-run' | 'public' | 'private'
export type SwapBackend = 'v2' | 'v3' | 'auto'

export interface BotConfig {
  chain: Chain
  chainName: string
  rpcHttp: string
  rpcWs?: string
  account: PrivateKeyAccount
  authAccount: PrivateKeyAccount
  liquidatorContract?: `0x${string}`
  mode: ExecutionMode
  minProfitUsd: number
  hfAlertThreshold: number
  scanIntervalSec: number
  fullScanEverySec: number
  slippageBps: number
  gasUnitsEstimate: bigint
  gasMultiplier: number
  discordWebhook?: string
  flashbotsRelay: string
  dataDir: string
  seedFromBlock?: bigint
  swapBackend: SwapBackend
}

function req(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`Missing required env var: ${name}`)
  return v
}

function num(name: string, fallback: number): number {
  const v = process.env[name]
  return v ? Number(v) : fallback
}

export function loadConfig(): BotConfig {
  const chainName = (process.env.CHAIN ?? 'sepolia').toLowerCase()
  const chains: Record<string, Chain> = { mainnet, sepolia, base, arbitrum }
  const chain = chains[chainName] ?? null
  if (!chain) throw new Error(`Unsupported CHAIN "${chainName}" (use ${Object.keys(chains).join(' | ')})`)

  const rpcHttp = process.env.RPC_URL_HTTP ?? (chain.rpcUrls.default.http[0] ?? '')
  if (!rpcHttp) throw new Error('RPC_URL_HTTP is required')
  const rpcWs = process.env.RPC_URL_WS || undefined

  const pk = req('PRIVATE_KEY')
  const account = privateKeyToAccount(pk as `0x${string}`)
  const authPk = process.env.AUTH_KEY || pk
  const authAccount = privateKeyToAccount(authPk as `0x${string}`)

  const mode = (process.env.EXECUTION_MODE ?? 'dry-run') as ExecutionMode
  if (!['dry-run', 'public', 'private'].includes(mode)) {
    throw new Error(`EXECUTION_MODE must be dry-run | public | private (got "${mode}")`)
  }

  const liquidatorContract = process.env.LIQUIDATOR_CONTRACT as `0x${string}` | undefined
  if (mode !== 'dry-run' && !liquidatorContract) {
    throw new Error(`EXECUTION_MODE=${mode} requires LIQUIDATOR_CONTRACT to be deployed & set`)
  }

  const hfAlertThreshold = num('HF_ALERT_THRESHOLD', 1.05)
  if (hfAlertThreshold > 1.0 && mode === 'dry-run') {
    // Fine in dry-run: lets you observe opportunities slightly before they are actionable.
  }

  const seedFromBlock = process.env.SEED_FROM_BLOCK ? BigInt(process.env.SEED_FROM_BLOCK) : undefined

  const swapBackend = (process.env.SWAP_BACKEND ?? 'auto') as SwapBackend
  if (!['v2', 'v3', 'auto'].includes(swapBackend)) {
    throw new Error(`SWAP_BACKEND must be v2 | v3 | auto (got "${swapBackend}")`)
  }

  return {
    chain,
    chainName,
    rpcHttp,
    rpcWs,
    account,
    authAccount,
    liquidatorContract,
    mode,
    minProfitUsd: num('MIN_PROFIT_USD', 10),
    hfAlertThreshold,
    scanIntervalSec: num('SCAN_INTERVAL_SEC', 12),
    fullScanEverySec: num('FULL_SCAN_EVERY_SEC', 600),
    slippageBps: num('SLIPPAGE_BPS', 100),
    gasUnitsEstimate: BigInt(num('GAS_UNITS_ESTIMATE', 1_500_000)),
    gasMultiplier: num('GAS_MULTIPLIER', 1.2),
    discordWebhook: process.env.DISCORD_WEBHOOK_URL || undefined,
    flashbotsRelay: process.env.FLASHBOTS_RELAY ?? 'https://relay.flashbots.net',
    dataDir: process.env.DATA_DIR ?? 'data',
    seedFromBlock,
    swapBackend,
  }
}

export interface Clients {
  publicClient: PublicClient
  walletClient: WalletClient
}

export function createClients(cfg: BotConfig): Clients {
  // WS preferred for event streaming; HTTP always used for signing/submitting.
  const watchTransport = cfg.rpcWs ? webSocket(cfg.rpcWs) : http(cfg.rpcHttp)
  const publicClient = createPublicClient({
    chain: cfg.chain,
    transport: watchTransport,
  }) as PublicClient
  const walletClient = createWalletClient({
    account: cfg.account,
    chain: cfg.chain,
    transport: http(cfg.rpcHttp),
  })
  return { publicClient, walletClient }
}
