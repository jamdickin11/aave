import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { PublicClient, Address } from 'viem'
import { getAbiItem, type AbiEvent } from 'viem'
import { PoolAbi } from '../abi.js'
import { log } from '../logger.js'

/**
 * Tracks candidate borrowers.
 *
 * Aave v3 has no on-chain iterator over users, so the registry is built by:
 *  1. Seeding from historical Borrow logs (chunked getLogs), and
 *  2. Streaming new Borrow events live (any new borrowing address is appended).
 *
 * Users drop out of the *watchlist* (not the registry) when their health factor
 * recovers above the recovery threshold during periodic rescans.
 */
export class UserRegistry {
  private users = new Set<Address>()
  private pendingNew = new Set<Address>()
  private dirty = false
  private filePath: string

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true })
    this.filePath = join(dataDir, 'users.json')
    this.load()
  }

  private load(): void {
    if (!existsSync(this.filePath)) return
    try {
      const raw = JSON.parse(readFileSync(this.filePath, 'utf8')) as string[]
      for (const u of raw) this.users.add(u.toLowerCase() as Address)
      log.info({ count: this.users.size }, 'registry loaded from disk')
    } catch (err) {
      log.warn({ err }, 'failed to load registry file; starting fresh')
    }
  }

  persist(): void {
    if (!this.dirty) return
    try {
      writeFileSync(this.filePath, JSON.stringify([...this.users], null, 0))
      this.dirty = false
    } catch (err) {
      log.warn({ err }, 'registry persist failed')
    }
  }

  add(user: Address): boolean {
    const k = user.toLowerCase() as Address
    if (this.users.has(k)) return false
    this.users.add(k)
    this.pendingNew.add(k)
    this.dirty = true
    return true
  }

  /** Returns and clears users discovered since the last drain (fast-path scanning). */
  drainNew(): Address[] {
    const out = [...this.pendingNew]
    this.pendingNew.clear()
    return out
  }

  list(): Address[] {
    return [...this.users]
  }

  get size(): number {
    return this.users.size
  }

  /**
   * Seed the registry from historical Borrow events.
   * Chunks logs to stay within typical RPC provider limits.
   */
  async seedFromLogs(
    client: PublicClient,
    pool: Address,
    fromBlock?: bigint,
    lookbackBlocks = 2_000_000n,
    chunkSize = 50_000n,
  ): Promise<void> {
    const tip = await client.getBlockNumber()
    const start = fromBlock ?? (tip > lookbackBlocks ? tip - lookbackBlocks : 0n)
    log.info({ from: start, to: tip, chunkSize: Number(chunkSize) }, 'seeding registry from Borrow logs')

    const borrowEvent = getAbiItem({ abi: PoolAbi, name: 'Borrow' }) as AbiEvent
    let added = 0
    for (let from = start; from <= tip; from += chunkSize + 1n) {
      const to = from + chunkSize > tip ? tip : from + chunkSize
      try {
        const logs = (await client.getLogs({
          address: pool,
          event: borrowEvent,
          fromBlock: from,
          toBlock: to,
        })) as Array<{ args?: { onBehalfOf?: Address } }>
        for (const l of logs) {
          // onBehalfOf accrues the debt — that is the account whose position matters
          if (l.args?.onBehalfOf && this.add(l.args.onBehalfOf)) added++
        }
      } catch (err) {
        log.warn({ from: String(from), to: String(to), err: String(err) }, 'seed chunk failed, continuing')
      }
    }
    this.dirty = true
    this.persist()
    log.info({ added, total: this.users.size }, 'registry seeding complete')
  }

  /** Live stream: every new Borrow adds its borrower. */
  watch(client: PublicClient, pool: Address): void {
    client.watchContractEvent({
      address: pool,
      abi: PoolAbi,
      eventName: 'Borrow',
      strict: false,
      onLogs: (logs) => {
        for (const l of logs as Array<{ args?: { onBehalfOf?: Address } }>) {
          const who = l.args?.onBehalfOf
          if (who && this.add(who)) {
            log.debug({ user: who }, 'new borrower tracked')
          }
        }
      },
      onError: (err) => log.warn({ err: String(err) }, 'borrow stream error'),
    })
    log.info('live Borrow stream attached')
  }
}
