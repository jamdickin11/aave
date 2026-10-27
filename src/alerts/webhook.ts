import type { BotConfig } from '../config.js'
import { log } from '../logger.js'

/**
 * Alerts (Discord webhook for now — Telegram is a trivial extension).
 * Used for: opportunity found, execution submitted/included/failed, errors.
 */
export async function alert(cfg: BotConfig, title: string, fields: Record<string, string | number>): Promise<void> {
  const lines = Object.entries(fields).map(([k, v]) => `**${k}**: ${v}`)
  const content = `⚡ **${title}**\n${lines.join('\n')}`
  log.info({ title, fields }, 'alert')
  if (!cfg.discordWebhook) return
  try {
    await fetch(cfg.discordWebhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    })
  } catch (err) {
    log.warn({ err: String(err) }, 'discord alert failed')
  }
}
