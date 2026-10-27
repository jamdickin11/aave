/**
 * Generate a dedicated burner wallet for the keeper bot.
 *
 *   npm run new-wallet
 *
 * SECURITY:
 *  - Print once, store in a password manager, fund it with ONLY the gas money
 *    the bot needs. Never reuse a wallet that holds long-term savings.
 *  - Anyone with this private key owns the wallet AND the deployed liquidator
 *    contract (it becomes the contract owner).
 */
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

const pk = generatePrivateKey()
const account = privateKeyToAccount(pk)

console.log('╔══════════════════════════════════════════════════════════════╗')
console.log('║  NEW KEEPER WALLET — store these two lines somewhere safe    ║')
console.log('╚══════════════════════════════════════════════════════════════╝')
console.log(`address:     ${account.address}`)
console.log(`private_key: ${pk}`)
console.log()
console.log('Next steps:')
console.log('  1. Put the private key in .env as PRIVATE_KEY=0x...')
console.log('  2. Fund the address with gas money (see RUNBOOK.md Stage 0).')
console.log('  3. NEVER share it, commit it, or reuse it elsewhere.')
