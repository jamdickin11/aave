import { keccak256, toHex, type Hex } from 'viem'
import type { PrivateKeyAccount } from 'viem/accounts'
import { log } from '../logger.js'

/**
 * Minimal Flashbots relay client (eth_sendBundle) built directly on fetch,
 * so no extra SDK dependency is needed.
 *
 * A bundle guarantees atomicity: either ALL transactions land (your liquidation
 * + nothing else can reorder between them), or none do. Builders cannot
 * sandwich you, and failed bundles cost nothing but the simulation.
 *
 * Docs: https://docs.flashbots.net/flashbots-auction/advanced/eip1559
 */
export class FlashbotsClient {
  constructor(
    private relayUrl: string,
    private authAccount: PrivateKeyAccount,
  ) {}

  private async post<T>(method: string, params: unknown[]): Promise<T> {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method,
      params,
    })
    // Flashbots auth: personal_sign over keccak256(body)
    const hash = keccak256(toHex(body))
    const sig = await this.authAccount.signMessage({ message: { raw: hash } })
    const res = await fetch(this.relayUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Flashbots-Signature': `${this.authAccount.address}:${sig}`,
      },
      body,
    })
    if (!res.ok) {
      throw new Error(`flashbots relay HTTP ${res.status}: ${await res.text().catch(() => '')}`)
    }
    const json = (await res.json()) as { result?: T; error?: { message: string } }
    if (json.error) throw new Error(`flashbots relay error: ${json.error.message}`)
    return json.result as T
  }

  /**
   * Submit signed raw transactions as a bundle for the given target block.
   * Returns the bundle hash.
   */
  async sendBundle(signedTxs: Hex[], targetBlock: bigint): Promise<string> {
    const result = await this.post<{ bundleHash: string }>('eth_sendBundle', [
      {
        txs: signedTxs.map((t) => t.slice(2)),
        blockNumber: toHex(targetBlock),
        revertingTxHashes: [],
      },
    ])
    return result.bundleHash
  }

  /** Optional: static-call the bundle at the target block to verify it would succeed. */
  async callBundle(signedTxs: Hex[], targetBlock: bigint): Promise<void> {
    await this.post('eth_callBundle', [
      {
        txs: signedTxs.map((t) => t.slice(2)),
        blockNumber: toHex(targetBlock),
        stateBlockNumber: 'latest',
      },
    ])
    log.info('bundle simulation via eth_callBundle succeeded')
  }

  /** Poll bundle inclusion for up to ~3 blocks. Returns true if included. */
  async waitInclusion(bundleHash: string, fromBlock: bigint, blocks = 3): Promise<boolean> {
    for (let i = 0; i < blocks; i++) {
      await new Promise((r) => setTimeout(r, 12_000))
      try {
        const res = await this.post<{ status: string }>('eth_getBundleStatus', [bundleHash])
        if (res?.status === 'Included') return true
      } catch {
        // some relays lack eth_getBundleStatus — fall back to block polling upstream
      }
    }
    void fromBlock
    return false
  }
}
