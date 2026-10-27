import type { Address, PublicClient, WalletClient } from 'viem'
import { encodeFunctionData, formatUnits } from 'viem'
import { FlashLoanLiquidatorAbi } from '../abi.js'
import type { Opportunity } from '../strategy/liquidation.js'
import type { BotConfig } from '../config.js'
import { log } from '../logger.js'

export interface PreparedTx {
  to: Address
  data: `0x${string}`
  gas: bigint // 0n until simulated — caller fills it in
  maxFeePerGas: bigint
  maxPriorityFeePerGas: bigint
  nonce: number
}

/**
 * Builds the calldata for FlashLoanLiquidator.liquidate(...) and fills in
 * EIP-1559 fee fields (with the configured multiplier applied).
 *
 * The swap route (router address + fee tier) was already selected by the
 * engine from real quotes — we only encode it here.
 */
export async function prepareLiquidationTx(
  cfg: BotConfig,
  client: PublicClient,
  wallet: WalletClient,
  opp: Opportunity,
): Promise<PreparedTx> {
  if (!cfg.liquidatorContract) throw new Error('LIQUIDATOR_CONTRACT is not set')

  const deadline = BigInt(Math.floor(Date.now() / 1000) + 180) // 3 min validity

  const data = encodeFunctionData({
    abi: FlashLoanLiquidatorAbi,
    functionName: 'liquidate',
    args: [
      opp.collateral.asset,
      opp.debt.asset,
      opp.user,
      opp.debtToCover,
      opp.route.minOut,
      opp.collateral.aToken,
      opp.route.router,
      opp.route.fee,
      deadline,
    ],
  })

  const feeData = await client.estimateFeesPerGas().catch(() => null)
  let maxFeePerGas = feeData?.maxFeePerGas
  let maxPriorityFeePerGas = feeData?.maxPriorityFeePerGas
  if (!maxFeePerGas) {
    maxFeePerGas = await client.getGasPrice()
    maxPriorityFeePerGas = 2n * 10n ** 9n
  }
  const boost = BigInt(Math.max(100, Math.round(cfg.gasMultiplier * 100)))
  maxFeePerGas = (maxFeePerGas * boost) / 100n
  maxPriorityFeePerGas = ((maxPriorityFeePerGas ?? 2n * 10n ** 9n) * boost) / 100n

  if (!wallet.account) throw new Error('wallet client has no account configured')
  const from = wallet.account.address

  const nonce = await client.getTransactionCount({
    address: from,
    blockTag: 'pending',
  })

  log.debug(
    {
      user: opp.user,
      eMode: opp.eModeActive,
      backend: opp.route.backend,
      feeTier: opp.route.fee,
      debt: opp.debt.asset,
      collateral: opp.collateral.asset,
      debtToCover: formatUnits(opp.debtToCover, opp.debt.decimals),
      minOut: formatUnits(opp.route.minOut, opp.debt.decimals),
    },
    'liquidation calldata prepared',
  )

  return {
    to: cfg.liquidatorContract,
    data,
    gas: 0n,
    maxFeePerGas,
    maxPriorityFeePerGas,
    nonce,
  }
}
