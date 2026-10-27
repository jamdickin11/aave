/**
 * Compile FlashLoanLiquidator.sol (in-process solc-js) and deploy it to the
 * chain selected by CHAIN in .env — no Foundry / external tooling required.
 *
 *   npm run compile            # compile only (sanity check, no RPC needed)
 *   npm run deploy             # compile + deploy to CHAIN
 *
 * The Aave Pool for CHAIN is used as the constructor arg (override with
 * AAVE_POOL env var). On success the script prints the exact line to add
 * to .env and saves data/deployment-<chain>.json.
 *
 * The deploying wallet becomes the contract OWNER — only it can call
 * liquidate() and sweep profits.
 */
import 'dotenv/config'
import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import solc from 'solc'
import { createPublicClient, http, type Abi, type Address } from 'viem'
import { loadConfig, createClients } from '../src/config.js'
import { poolAddressFor } from '../src/chains.js'
import { log } from '../src/logger.js'

const compileOnly = process.argv.includes('--compile-only')

interface Compiled {
  abi: Abi
  bytecode: `0x${string}`
}

function compileLiquidator(): Compiled {
  const solPath = path.resolve(fileURLToPath(import.meta.url), '../../contracts/FlashLoanLiquidator.sol')
  const source = readFileSync(solPath, 'utf8')

  const input = {
    language: 'Solidity',
    sources: { 'FlashLoanLiquidator.sol': { content: source } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      // 'paris' avoids the PUSH0 opcode so the same bytecode deploys on every
      // supported chain regardless of its Shanghai/Cancun support.
      evmVersion: 'paris',
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
    },
  }

  const output = JSON.parse(solc.compile(JSON.stringify(input))) as {
    errors?: { severity: string; formattedMessage: string }[]
    contracts: Record<string, Record<string, {
      abi: Abi
      evm: { bytecode: { object: string } }
    }>>
  }

  const errors = (output.errors ?? []).filter((e) => e.severity === 'error')
  if (errors.length > 0) {
    throw new Error('solc compilation failed:\n' + errors.map((e) => e.formattedMessage).join('\n'))
  }

  const contract = output.contracts['FlashLoanLiquidator.sol']['FlashLoanLiquidator']
  if (!contract) throw new Error('solc output missing FlashLoanLiquidator artifact')

  const warnings = (output.errors ?? []).filter((e) => e.severity === 'warning')
  for (const w of warnings) log.warn(w.formattedMessage.split('\n')[1] ?? 'solc warning')

  return {
    abi: contract.abi,
    bytecode: `0x${contract.evm.bytecode.object}` as `0x${string}`,
  }
}

async function main(): Promise<void> {
  const compiled = compileLiquidator()
  log.info({ bytecodeBytes: (compiled.bytecode.length - 2) / 2 }, 'compiled FlashLoanLiquidator.sol')

  if (compileOnly) {
    log.info('--compile-only: stopping before deployment (RPC not touched)')
    return
  }

  const cfg = loadConfig() // validates PRIVATE_KEY, CHAIN
  const { publicClient, walletClient } = createClients(cfg)
  const account = walletClient.account
  if (!account) throw new Error('wallet client has no account configured')

  const pool = poolAddressFor(cfg.chainName)
  const balance = await publicClient.getBalance({ address: account.address })
  log.info({ chain: cfg.chainName, deployer: account.address, pool, balanceEth: Number(balance) / 1e18 }, 'deploying')

  if (balance === 0n) {
    throw new Error(
      `Deployer wallet ${account.address} has zero balance on ${cfg.chainName}. ` +
      'Fund it with gas money first (see RUNBOOK.md Stage 0).',
    )
  }

  // EIP-1559 fees with a headroom multiplier so the deploy doesn't stall.
  const fee = await publicClient.estimateFeesPerGas().catch(() => null)
  const maxFeePerGas = ((fee?.maxFeePerGas ?? await publicClient.getGasPrice()) * 130n) / 100n
  const maxPriorityFeePerGas = ((fee?.maxPriorityFeePerGas ?? 2n * 10n ** 9n) * 130n) / 100n

  const hash = await walletClient.deployContract({
    abi: compiled.abi,
    bytecode: compiled.bytecode,
    args: [pool satisfies Address],
    account,
    chain: cfg.chain,
    maxFeePerGas,
    maxPriorityFeePerGas,
  })
  log.info({ hash }, 'deployment tx sent — waiting for receipt')

  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 })
  if (receipt.status !== 'success' || !receipt.contractAddress) {
    throw new Error(`deployment failed (status=${receipt.status}) — inspect tx ${hash}`)
  }

  const address = receipt.contractAddress
  const gasEth = Number(receipt.gasUsed * (receipt.effectiveGasPrice ?? maxFeePerGas)) / 1e18

  // Persist a deployment record.
  const dataDir = path.resolve(fileURLToPath(import.meta.url), '../../data')
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true })
  const record = {
    chain: cfg.chainName,
    address,
    txHash: hash,
    deployer: account.address,
    owner: account.address,
    aavePool: pool,
    blockNumber: String(receipt.blockNumber),
    gasPaidEth: gasEth.toFixed(6),
    deployedAt: new Date().toISOString(),
  }
  writeFileSync(path.join(dataDir, `deployment-${cfg.chainName}.json`), JSON.stringify(record, null, 2))

  console.log('')
  console.log('──────────────────────────────────────────────────────────────')
  console.log(`  FlashLoanLiquidator deployed on ${cfg.chainName}`)
  console.log(`  Contract : ${address}`)
  console.log(`  Owner    : ${account.address}  (keeper wallet)`)
  console.log(`  Aave Pool: ${pool}`)
  console.log(`  Gas paid : ${gasEth.toFixed(6)} ETH   tx: ${hash}`)
  console.log('──────────────────────────────────────────────────────────────')
  console.log('')
  console.log('Add this line to your .env now:')
  console.log(`  LIQUIDATOR_CONTRACT=${address}`)
  console.log('')
  console.log('Then run:  npm run scan-once   (dry-run still on — see RUNBOOK.md)')
}

main().catch((err) => {
  log.fatal({ err: String(err).slice(0, 800) }, 'deploy failed')
  process.exit(1)
})
