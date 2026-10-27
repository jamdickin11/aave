import { formatUnits, type Hex } from 'viem'
import type { BotConfig, Clients } from '../config.js'
import type { Opportunity } from '../strategy/liquidation.js'
import { prepareLiquidationTx, type PreparedTx } from './tx.js'
import { FlashbotsClient } from './flashbots.js'
import { alert } from '../alerts/webhook.js'
import { log } from '../logger.js'

export type ExecutionResult =
  | { kind: 'dry-run'; tx: PreparedTx; simulated: boolean }
  | { kind: 'public'; hash: Hex }
  | { kind: 'bundle'; bundleHash: string; targetBlock: bigint }
  | { kind: 'skipped'; reason: string }

/**
 * Executes one opportunity according to EXECUTION_MODE:
 *
 *  - dry-run : simulate (estimateGas performs an eth_call against latest state),
 *              alert, and stop. This catches "already liquidated / HF >= 1 /
 *              approval math wrong" reverts before any real money moves.
 *  - public  : sign and broadcast to the public mempool.
 *  - private : sign and submit as a Flashbots bundle for the next block.
 */
export async function executeOpportunity(
  cfg: BotConfig,
  clients: Clients,
  opp: Opportunity,
): Promise<ExecutionResult> {
  const { publicClient, walletClient } = clients
  const account = walletClient.account
  if (!account) throw new Error('wallet client has no account configured')

  if (opp.netUsd < cfg.minProfitUsd) {
    return { kind: 'skipped', reason: `net $${opp.netUsd.toFixed(2)} < threshold $${cfg.minProfitUsd}` }
  }

  const tx = await prepareLiquidationTx(cfg, publicClient, walletClient, opp)

  // ---- simulation -----------------------------------------------------------
  let simulated = false
  if (cfg.liquidatorContract) {
    try {
      tx.gas = await publicClient.estimateGas({
        account: walletClient.account,
        to: tx.to,
        data: tx.data,
      })
      simulated = true
      log.info(
        { user: opp.user, gas: String(tx.gas), netUsd: opp.netUsd.toFixed(2) },
        'simulation PASSED — liquidation call would execute',
      )
    } catch (err) {
      log.info(
        { user: opp.user, err: String(err).slice(0, 300) },
        'simulation reverted — position likely no longer liquidatable or race lost; skipping',
      )
      return { kind: 'skipped', reason: 'simulation reverted' }
    }
  } else {
    tx.gas = cfg.gasUnitsEstimate
    log.warn('no LIQUIDATOR_CONTRACT set — using configured gas estimate instead of real simulation')
  }

  const summary = {
    user: opp.user,
    eMode: opp.eModeActive ? 'YES (100% close factor)' : 'no',
    route: `${opp.route.backend}${opp.route.fee ? `:${opp.route.fee}` : ''}`,
    netProfit: `$${opp.netUsd.toFixed(2)}`,
    gross: `$${opp.grossUsd.toFixed(2)}`,
    flashFee: `$${opp.flashFeeUsd.toFixed(2)}`,
    gas: `$${opp.gasUsd.toFixed(2)}`,
    debtCovered: formatUnits(opp.debtToCover, opp.debt.decimals),
    collateralSeized: formatUnits(opp.collateralSeizedUnits, opp.collateral.decimals),
  }

  // ---- mode dispatch --------------------------------------------------------
  if (cfg.mode === 'dry-run') {
    await alert(cfg, 'DRY-RUN liquidation opportunity', summary)
    return { kind: 'dry-run', tx, simulated }
  }

  if (cfg.mode === 'public') {
    const hash = await walletClient.sendTransaction({
      account,
      chain: cfg.chain,
      to: tx.to,
      data: tx.data,
      gas: tx.gas,
      maxFeePerGas: tx.maxFeePerGas,
      maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
      nonce: tx.nonce,
    })
    await alert(cfg, 'Liquidation broadcast (public mempool)', { ...summary, txHash: hash })
    log.info({ hash }, 'public tx sent')
    return { kind: 'public', hash }
  }

  // private mode: Flashbots bundle for the next block
  const fb = new FlashbotsClient(cfg.flashbotsRelay, cfg.authAccount)
  const raw = (await walletClient.signTransaction({
    account,
    chain: cfg.chain,
    to: tx.to,
    data: tx.data,
    gas: tx.gas,
    maxFeePerGas: tx.maxFeePerGas,
    maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
    nonce: tx.nonce,
  })) as Hex

  const tip = await publicClient.getBlockNumber()
  const targetBlock = tip + 1n
  try {
    await fb.callBundle([raw], targetBlock)
  } catch (err) {
    log.info({ err: String(err).slice(0, 200) }, 'eth_callBundle failed — bundle would revert; skipping')
    return { kind: 'skipped', reason: 'bundle simulation reverted' }
  }
  const bundleHash = await fb.sendBundle([raw], targetBlock)
  await alert(cfg, 'Liquidation bundle submitted (Flashbots)', {
    ...summary,
    targetBlock: String(targetBlock),
    bundleHash,
  })
  log.info({ bundleHash, targetBlock: String(targetBlock) }, 'bundle submitted')
  return { kind: 'bundle', bundleHash, targetBlock }
}
