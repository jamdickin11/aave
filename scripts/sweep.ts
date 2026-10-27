/**
 * Withdraw profit from the deployed FlashLoanLiquidator back to your wallet.
 *
 *   npm run sweep -- --token 0x<debtAssetAddress>          # sweep a token
 *   npm run sweep -- --eth                                 # sweep stray ETH
 *   npm run sweep -- --token 0x<addr> --to 0x<recipient>   # custom recipient
 *
 * Profits accumulate in the CONTRACT (in whatever asset the swap returned —
 * normally the debt asset, because the flash loan is repaid from swap output
 * and the leftover bonus is what's left). Requires LIQUIDATOR_CONTRACT in
 * .env and must be run with the OWNER key (PRIVATE_KEY).
 */
import 'dotenv/config'
import { encodeFunctionData, formatEther, type Address } from 'viem'
import { loadConfig, createClients } from '../src/config.js'
import { log } from '../src/logger.js'

const SweepAbi = [
  {
    name: 'sweepToken',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'to', type: 'address' },
    ],
    outputs: [],
  },
  {
    name: 'sweepEth',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'to', type: 'address' }],
    outputs: [],
  },
  {
    name: 'owner',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
] as const

function argOf(flag: string): string | undefined {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : undefined
}

async function main(): Promise<void> {
  const cfg = loadConfig()
  const { publicClient, walletClient } = createClients(cfg)
  const account = walletClient.account
  if (!account) throw new Error('wallet client has no account configured')

  const contract = cfg.liquidatorContract
  if (!contract) {
    throw new Error('LIQUIDATOR_CONTRACT is not set in .env (deploy first: npm run deploy)')
  }

  // Safety: only the contract owner can sweep — check before burning gas.
  const owner = await publicClient.readContract({ address: contract, abi: SweepAbi, functionName: 'owner' })
  if (owner.toLowerCase() !== account.address.toLowerCase()) {
    throw new Error(
      `Wallet ${account.address} is NOT the contract owner (${owner}). ` +
      'Sweep must be sent from the wallet that deployed the contract.',
    )
  }

  const recipient = (argOf('--to') ?? account.address) as Address
  const isEth = process.argv.includes('--eth')
  const token = argOf('--token')

  if (!isEth && !token) {
    throw new Error('Nothing to sweep. Use:  npm run sweep -- --token 0x<addr>   or   npm run sweep -- --eth')
  }
  if (token && !/^0x[0-9a-fA-F]{40}$/.test(token)) {
    throw new Error(`--token must be a 0x-prefixed 20-byte address, got "${token}"`)
  }

  const nonce = await publicClient.getTransactionCount({ address: account.address, blockTag: 'pending' })
  const fee = await publicClient.estimateFeesPerGas().catch(() => null)
  const maxFeePerGas = ((fee?.maxFeePerGas ?? await publicClient.getGasPrice()) * 120n) / 100n
  const maxPriorityFeePerGas = ((fee?.maxPriorityFeePerGas ?? 2n * 10n ** 9n) * 120n) / 100n

  const data = isEth
    ? encodeFunctionData({ abi: SweepAbi, functionName: 'sweepEth', args: [recipient] })
    : encodeFunctionData({ abi: SweepAbi, functionName: 'sweepToken', args: [token as Address, recipient] })

  const hash = await walletClient.sendTransaction({
    account,
    chain: cfg.chain,
    to: contract,
    data,
    gas: 120_000n,
    maxFeePerGas,
    maxPriorityFeePerGas,
    nonce,
  })
  log.info({ hash }, `sweep tx sent (${isEth ? 'ETH' : token}) → ${recipient}`)

  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 })
  console.log('')
  console.log(`Sweep ${receipt.status === 'success' ? 'confirmed' : 'FAILED'} — tx ${hash}`)
  console.log(`Gas paid: ${formatEther(receipt.gasUsed * (receipt.effectiveGasPrice ?? maxFeePerGas))} ETH`)
}

main().catch((err) => {
  log.fatal({ err: String(err).slice(0, 500) }, 'sweep failed')
  process.exit(1)
})
