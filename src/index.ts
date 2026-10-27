#!/usr/bin/env node
/**
 * Aave v3 flash-loan liquidation keeper — main entrypoint.
 *
 * Loop:
 *   1. Maintain a registry of borrowers (seeded from Borrow logs + live stream).
 *   2. Scan health factors (multicall, batched) every SCAN_INTERVAL_SEC for the
 *      active watchlist; rescan the full registry every FULL_SCAN_EVERY_SEC.
 *   3. For users with HF below the threshold, build the most profitable
 *      (collateral, debt) liquidation pair and act:
 *        dry-run  -> simulate + alert (default; no transactions)
 *        public   -> broadcast to the mempool
 *        private  -> Flashbots bundle for the next block
 *
 * Run once for a smoke test:  npm run scan-once
 * Run continuously:           npm start
 */
// Load .env if present (dotenv handles this, but be explicit about cwd)
import 'dotenv/config'

import { loadConfig, createClients, type BotConfig } from './config.js'
import { resolveAddressBook } from './chains.js'
import { PoolAbi } from './abi.js'
import { log } from './logger.js'
import { UserRegistry } from './monitor/registry.js'
import { scanHealth } from './monitor/scanner.js'
import { ReserveCache } from './strategy/reserves.js'
import { LiquidationEngine } from './strategy/liquidation.js'
import { executeOpportunity } from './executor/index.js'

const once = process.argv.includes('--once')

async function main(): Promise<void> {
  const cfg: BotConfig = loadConfig()
  log.info(
    {
      chain: cfg.chainName,
      mode: cfg.mode,
      minProfitUsd: cfg.minProfitUsd,
      hfThreshold: cfg.hfAlertThreshold,
      wallet: cfg.account.address,
    },
    'liquidation keeper starting',
  )

  const { publicClient, walletClient } = createClients(cfg)
  const book = await resolveAddressBook(publicClient, cfg.chainName)
  log.info(
    { pool: book.pool, oracle: book.oracle, dataProvider: book.dataProvider, router: book.uniswapV2Router },
    'addresses resolved',
  )

  // Flash-loan premium (Aave v3 default: 5 bps = 0.05%)
  let premiumBps = 5n
  try {
    premiumBps = (await publicClient.readContract({
      address: book.pool,
      abi: PoolAbi,
      functionName: 'FLASHLOAN_PREMIUM_TOTAL',
    })) as bigint
  } catch {
    log.warn('could not read FLASHLOAN_PREMIUM_TOTAL; assuming 5 bps')
  }

  const registry = new UserRegistry(cfg.dataDir)
  const cache = new ReserveCache(publicClient, book.pool, book.dataProvider)
  const engine = new LiquidationEngine({
    client: publicClient,
    pool: book.pool,
    oracle: book.oracle,
    weth: book.weth,
    flashPremiumBps: premiumBps,
    slippageBps: cfg.slippageBps,
    gasUnits: cfg.gasUnitsEstimate,
    swapBackend: cfg.swapBackend,
    uniswapV2Router: book.uniswapV2Router,
    swapRouter02: book.swapRouter02,
    quoterV2: book.quoterV2,
  })
  engine.setCache(cache)

  // Seed the registry, then follow live borrows
  await registry.seedFromLogs(publicClient, book.pool, cfg.seedFromBlock)
  registry.watch(publicClient, book.pool)

  let watchlist: Awaited<ReturnType<typeof scanHealth>> = []
  let lastFullScan = 0
  let running = true

  const tick = async (): Promise<void> => {
    const now = Date.now()
    const fullDue = now - lastFullScan > cfg.fullScanEverySec * 1000

    if (fullDue || watchlist.length === 0) {
      log.info({ registrySize: registry.size }, 'full registry scan')
      watchlist = await scanHealth(publicClient, book.pool, registry.list(), cfg.hfAlertThreshold)
      lastFullScan = now
    } else {
      // Cheap pass: previous watchlist + borrowers seen since the last tick,
      // so fresh positions get scanned without waiting for the next full sweep.
      const fresh = registry.drainNew()
      const targets = [...watchlist.map((c) => c.user), ...fresh]
      watchlist = await scanHealth(publicClient, book.pool, targets, cfg.hfAlertThreshold)
    }
    registry.persist()

    if (watchlist.length === 0) return
    log.info({ candidates: watchlist.length }, 'users below alert threshold')

    for (const candidate of watchlist.slice(0, 5)) {
      const opp = await engine.buildOpportunity(candidate)
      if (!opp) continue
      log.info(
        {
          user: opp.user,
          hf: Number(opp.healthFactor) / 1e18,
          eMode: opp.eModeActive,
          route: `${opp.route.backend}${opp.route.fee ? ':' + opp.route.fee : ''}`,
          gross: opp.grossUsd.toFixed(2),
          fee: opp.flashFeeUsd.toFixed(2),
          gas: opp.gasUsd.toFixed(2),
          net: opp.netUsd.toFixed(2),
        },
        'opportunity',
      )
      try {
        await executeOpportunity(cfg, { publicClient, walletClient }, opp)
      } catch (err) {
        log.error({ err: String(err).slice(0, 400) }, 'execution error')
      }
    }
  }

  // Periodic registry persistence even between scans
  const persistTimer = setInterval(() => registry.persist(), 30_000)

  const shutdown = (): void => {
    running = false
    clearInterval(persistTimer)
    registry.persist()
    log.info('shutting down')
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  await tick()
  if (once) {
    clearInterval(persistTimer)
    log.info('--once: single scan complete')
    return
  }
  while (running) {
    await new Promise((r) => setTimeout(r, cfg.scanIntervalSec * 1000))
    try {
      await tick()
    } catch (err) {
      log.error({ err: String(err).slice(0, 400) }, 'tick failed')
    }
  }
}

main().catch((err) => {
  log.fatal({ err: String(err) }, 'fatal')
  process.exit(1)
})
