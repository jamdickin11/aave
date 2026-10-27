# RUNBOOK — Launching the liquidation bot on a real chain

Step-by-step path from zero to a live, executing liquidation bot. Follow the
stages in order — each one gates the next. Nothing in Stage 0–3 can lose money
beyond faucet/gas dust; real funds only appear in Stage 6.

```
Stage 0  wallet + funding + RPC          (no risk)
Stage 1  .env configuration              (no risk)
Stage 2  first dry-run scan on Sepolia   (no risk — read-only)
Stage 3  compile + deploy contract       (testnet gas dust)
Stage 4  rehearse on a mainnet fork      (no risk — fake ETH)
Stage 5  choose your production chain    (decision)
Stage 6  GO LIVE on Base/Arbitrum/mainnet (REAL FUNDS — checklist gated)
Stage 7  operate: sweep, monitor, tune
```

Command cheat sheet:

| Command | What it does |
|---|---|
| `npm run new-wallet` | Generate a dedicated burner keeper wallet |
| `npm run scan-once` | One read-only monitoring pass (no transactions ever) |
| `npm start` | Continuous keeper loop |
| `npm run compile` | Compile `FlashLoanLiquidator.sol` in-process (no RPC) |
| `npm run deploy` | Compile + deploy the contract to `CHAIN` |
| `npm run sweep -- --token 0x…` | Withdraw profit tokens from the contract to your wallet |
| `npm run sweep -- --eth` | Withdraw stray ETH from the contract |
| `npm run simulate` | Offline unit-economics sanity check |
| `npm run typecheck` | TypeScript sanity |

---

## Stage 0 — Wallet, funding, RPC (~30 min, no risk)

### 0.1 Create the keeper wallet

Use a **dedicated burner wallet** — never your main wallet. The bot's private
key signs every liquidation and becomes the contract owner.

```bash
npm run new-wallet
```

Output looks like:

```
address:     0x1234...abcd
private_key: 0x5678...ef01
```

Store both in a password manager. This key should only ever hold gas money.

### 0.2 Fund it

| Chain you will run | Where to get funds | How much |
|---|---|---|
| **Sepolia (test)** | Google Cloud faucet (cloud.google.com → Web3 → Sepolia), Alchemy faucet (sepoliafaucet.com), or a friend with testnet ETH | 0.3–0.5 test ETH |
| **Base** (recommended first live chain) | Withdraw ETH from an exchange **directly to Base**, or bridge via bridge.base.org | $5–20 of ETH |
| **Arbitrum** | Exchange withdrawal direct to Arbitrum One, or bridge.arbitrum.io | $5–20 of ETH |
| **Ethereum mainnet** | Exchange withdrawal to the keeper address | 0.3–1 ETH |

Exchange withdrawals direct to L2s are cheapest and arrive in minutes. Double-
check the network selector before sending — funds sent on the wrong network
are a common, mostly-irreversible mistake.

### 0.3 Get RPC endpoints

Sign up at **Alchemy**, **Infura**, or **QuickNode** (free tiers are fine for
testing; production wants a paid tier or your own node for latency). Create
one app per chain you plan to run and copy **both** the HTTP and WebSocket
URLs — the bot uses WS for live event streaming and HTTP for signing.

You can also test freely against public endpoints first:

| Chain | HTTP (public, testing only) | WS (public, testing only) |
|---|---|---|
| Sepolia | `https://ethereum-sepolia-rpc.publicnode.com` | `wss://ethereum-sepolia-rpc.publicnode.com/ws` |
| Mainnet | `https://ethereum-rpc.publicnode.com` | `wss://ethereum-rpc.publicnode.com/ws` |
| Base | `https://base-rpc.publicnode.com` | `wss://base-rpc.publicnode.com/ws` |
| Arbitrum | `https://arbitrum-one-rpc.publicnode.com` | `wss://arbitrum-one-rpc.publicnode.com/ws` |

Public endpoints are rate-limited and slow — fine for Stages 2–3, not for live
racing (Stage 6).

---

## Stage 1 — Configure .env

```bash
cp .env.example .env
```

Fill in now:

```ini
CHAIN=sepolia
RPC_URL_HTTP=https://ethereum-sepolia-rpc.publicnode.com
RPC_URL_WS=wss://ethereum-sepolia-rpc.publicnode.com/ws
PRIVATE_KEY=0x<your keeper key from Stage 0.1>
EXECUTION_MODE=dry-run          # stays dry-run until Stage 6
MIN_PROFIT_USD=10
HF_ALERT_THRESHOLD=1.05
SLIPPAGE_BPS=100
SWAP_BACKEND=auto
```

Notes:

- `PRIVATE_KEY` — from `npm run new-wallet`. Keep `.env` out of git
  (`.gitignore` already excludes it) and never paste it anywhere.
- `EXECUTION_MODE=dry-run` — the bot will monitor, compute, and simulate but
  **never send a transaction**. This is the safety default; you will only
  change it in Stage 6.
- `LIQUIDATOR_CONTRACT` — leave empty for now; the deploy step in Stage 3
  fills it.
- `DISCORD_WEBHOOK_URL` — optional but genuinely useful: every dry-run
  opportunity and live action gets pushed to your channel.

---

## Stage 2 — First dry-run scan (read-only)

```bash
npm run scan-once
```

What you should see, in order:

```
INFO: liquidation keeper starting  chain=sepolia mode=dry-run wallet=0x1234…
INFO: addresses resolved  pool=0x6Ae4…  oracle=0x…  dataProvider=0x…
INFO: full registry scan  registrySize=0
INFO: seeding borrowers from Borrow logs …
INFO: full registry scan  registrySize=842
INFO: users below alert threshold  candidates=1
INFO: opportunity { user: 0x…, hf: 0.98, eMode: true, route: v2, gross: 31.20, fee: 0.31, gas: 0.04, net: 30.85 }
INFO: DRY-RUN liquidation opportunity …
INFO: --once: single scan complete
```

How to read it:

- **registrySize** — how many borrower addresses were discovered from Aave
  `Borrow` logs. First run seeds ~2M blocks back (overridable via
  `SEED_FROM_BLOCK`). On Sepolia this can take a few minutes; on mainnet with
  a rate-limited free RPC it can take much longer.
- **candidates** — users whose health factor is below `HF_ALERT_THRESHOLD`.
- **opportunity** — the engine's math for one candidate: gross bonus, flash
  fee, gas, and the net USD after everything. The engine only acts when
  `net ≥ MIN_PROFIT_USD`.

Then let it run continuously for a while:

```bash
npm start        # Ctrl+C to stop — safe at any time in dry-run
```

Run this for **at least a few hours** (ideally a day, spanning a volatile
period). You are verifying three things: the process stays up, the RPC holds,
and opportunities are being computed with sane numbers.

Common issues:

| Symptom | Cause | Fix |
|---|---|---|
| `Could not resolve Aave price oracle` | Wrong/mismatched RPC for the chain | Check `RPC_URL_HTTP` matches `CHAIN` |
| `rate limit` / 429 errors | Free public RPC | Add `SEED_FROM_BLOCK=<recent>` to narrow the log scan, or use a provider key |
| `registrySize=0` after a long wait | RPC blocks historical `getLogs` | Set `SEED_FROM_BLOCK` to e.g. tip − 200,000 and retry; it rebuilds organically anyway |
| No candidates for hours | Normal on quiet testnets | Lower `HF_ALERT_THRESHOLD` slightly (e.g. 1.02) just to see scanning work |

---

## Stage 3 — Compile and deploy the liquidator contract

The Solidity contract is the on-chain executor: it flash-borrows, liquidates,
swaps, repays, and holds profit atomically. The bot (owner) is the only caller
allowed to trigger it.

```bash
npm run compile   # sanity: compiles in-process, prints bytecode size, touches nothing
npm run deploy    # compiles + broadcasts to CHAIN
```

Expected deploy output:

```
INFO: compiled FlashLoanLiquidator.sol  bytecodeBytes=5501
INFO: deploying  chain=sepolia deployer=0x1234…  pool=0x6Ae4…  balanceEth=0.42
INFO: deployment tx sent — waiting for receipt
──────────────────────────────────────────────────────────────
  FlashLoanLiquidator deployed on sepolia
  Contract : 0xABCD…1234
  Owner    : 0x1234…  (keeper wallet)
  Aave Pool: 0x6Ae4…
  Gas paid : 0.0012 ETH   tx: 0x…
──────────────────────────────────────────────────────────────
Add this line to your .env now:
  LIQUIDATOR_CONTRACT=0xABCD…1234
```

Copy that `LIQUIDATOR_CONTRACT=…` line into `.env` exactly as printed. A
deployment record is also saved to `data/deployment-<chain>.json`.

Details worth knowing:

- **Deployer = owner.** Only this wallet can call `liquidate()` and
  `sweepToken()/sweepEth()`. If you later want to move ownership:
  `setOwner(newOwner)` from the owner wallet.
- **No private key in the contract, no admin upgrades** — it is a plain,
  immutable contract; funds inside can only be moved out via the owner-only
  sweep functions.
- **Etherscan verification (optional).** Explorer UI → Add contract →
  compiler `v0.8.26`, optimizer **enabled, 200 runs**, EVM version `paris`,
  paste `contracts/FlashLoanLiquidator.sol` (single file, no imports).
- **Redeploying later is cheap and safe** — deploy per chain, one contract
  per chain.

Quick smoke test with the contract live (still dry-run mode):

```bash
npm run scan-once
```

You should now see an extra line on candidates:

```
INFO: simulation PASSED — liquidation call would execute
```

The executor runs a real `eth_estimateGas` against the deployed contract —
this is a full replay of the flash loan + liquidation + swap against current
state. "simulation PASSED" means the entire atomic flow would succeed right
now.

---

## Stage 4 — Rehearse a REAL liquidation on a mainnet fork (no risk)

Dry-run proves the bot *finds* candidates; a fork proves it *executes*. Anvil
(Foundry) replays Ethereum mainnet locally with 10,000 fake ETH in known dev
accounts — you can fire real liquidations against real state with zero risk.

```bash
# 1. Install Foundry (one-time)
curl -L https://foundry.paradigm.xyz | bash && foundryup

# 2. Fork mainnet at a block shortly after a big market dip — that is when
#    liquidatable positions actually exist. Example: the Aug 5 2024 crash
#    (~block 20,530,000 — pick your own volatile block and verify on Etherscan).
anvil --fork-url https://ethereum-rpc.publicnode.com --fork-block-number 20530000
```

In a **second terminal**, run the bot against the fork. Inline env vars
override `.env` values (dotenv does not overwrite what you pass on the
command line), so your real `.env` stays untouched:

```bash
CHAIN=mainnet \
RPC_URL_HTTP=http://127.0.0.1:8545 \
PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
EXECUTION_MODE=public \
MIN_PROFIT_USD=0.01 \
HF_ALERT_THRESHOLD=1.02 \
SLIPPAGE_BPS=300 \
npm run deploy
```

Take the printed `LIQUIDATOR_CONTRACT=…` address and add it to the same
inline-env command, then start the keeper:

```bash
CHAIN=mainnet \
RPC_URL_HTTP=http://127.0.0.1:8545 \
PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
LIQUIDATOR_CONTRACT=0x<address printed above> \
EXECUTION_MODE=public \
MIN_PROFIT_USD=0.01 \
HF_ALERT_THRESHOLD=1.02 \
SLIPPAGE_BPS=300 \
npm start
```

The `0xac09…` key is anvil's well-known dev key — **it is only valid on your
local fork; never use it on a real chain** (its address holds real mainnet
USDC from copy-paste victims, and everyone knows the key).

Success looks like:

```
INFO: opportunity { … route: v3:500, gross: …, net: … }
INFO: simulation PASSED — liquidation call would execute
INFO: public tx sent  hash=0x…
```

Then inspect on the fork: `cast receipt 0x<hash> --rpc-url http://127.0.0.1:8545`
and look for the `Liquidated` event — user, collateral, debt covered, and the
profit left in the contract. Confirm the keeper wallet's fake ETH balance went
UP by the gas + net profit.

Tips:

- If no candidates appear at your fork block, pick a different (more volatile)
  block. Liquidatable positions cluster minutes after large price moves.
- Expect most candidates to log `simulation reverted — position likely no
  longer liquidatable or race lost; skipping`. That is correct behavior: the
  estimateGas call is your free preview of reality.
- This rehearsal exercises the full path: registry → scan → pair selection →
  real quotes → calldata → deploy check → atomic execution.

---

## Stage 5 — Choose your production chain

| | Ethereum mainnet | **Base** | **Arbitrum** |
|---|---|---|---|
| Gas per liquidation | $5–40 | <$0.05 | <$0.10 |
| Bot competition | Extreme (MEV industry) | Low–medium | Medium |
| Market depth | Deepest | Medium (WETH/USDC/core assets) | Deep |
| Failed-tx gas risk | High in public mempool | Minimal | Minimal |
| Private submission | **Required** (`private`/Flashbots) | Not needed (`public`) | Not needed (`public`) |
| Suggested `MIN_PROFIT_USD` | 40–100 | 5–15 | 5–15 |
| Verdict | Later, after L2 success | **Start here** | Second choice |

**Recommendation: go live on Base or Arbitrum first.** Gas is effectively
free, so a failed race costs cents instead of dollars, and there are far fewer
competing liquidators than on mainnet. Move to mainnet only after you have
seen real executions on L2.

---

## Stage 6 — GO LIVE (real funds)

### 6.1 Pre-flight checklist (all must be true)

- [ ] Stage 2 done: 24h+ of stable dry-run on this chain's RPC
- [ ] Stage 3 done: contract deployed **on this chain**, `LIQUIDATOR_CONTRACT` set
- [ ] Stage 4 (or at minimum, dry-run `simulation PASSED` events) seen at least once
- [ ] Keeper wallet funded with gas (Stage 0.2 amounts)
- [ ] `MIN_PROFIT_USD` set from the Stage 5 table
- [ ] Dedicated burner key only — nothing else ever uses it
- [ ] You understand: every live action spends real gas and races other bots; simulation reverts and lost races are normal operating costs

### 6.2 L2 path (Base / Arbitrum — recommended)

```ini
CHAIN=base
RPC_URL_HTTP=<paid provider HTTP url>
RPC_URL_WS=<paid provider WS url>
EXECUTION_MODE=public
MIN_PROFIT_USD=10
SLIPPAGE_BPS=100
SWAP_BACKEND=auto
```

```bash
npm run deploy      # one contract per chain — deploy fresh on Base
# add LIQUIDATOR_CONTRACT=… to .env
npm start
```

Router addresses for Base/Arbitrum are pre-verified in `src/chains.ts`
(Basescan/Arbiscan name-tags + official Uniswap deployment tables). The
`auto` backend quotes both V2 and all four V3 fee tiers and picks the best
real quote for each opportunity. If you want to double-check any address,
search it on the explorer and confirm the name-tag before trusting it.

### 6.3 Mainnet path (Flashbots, after L2 success)

```ini
CHAIN=mainnet
EXECUTION_MODE=private
MIN_PROFIT_USD=50
SLIPPAGE_BPS=80
```

```bash
npm run deploy      # separate mainnet contract
npm start
```

Why `private` and never `public` on mainnet:

1. **Mempool copying** — a public liquidation tx can be seen and duplicated by
   any bot with a higher tip; you pay gas, they take the profit.
2. **Revert refunds** — with Flashbots, a bundle that would revert is simply
   not included: the bot pre-checks with `eth_callBundle` and you pay
   **nothing** for failed races. In the public mempool every failed attempt
   burns real gas.
3. No signup needed — the relay authenticates via the wallet's signature
   (`AUTH_KEY` defaults to `PRIVATE_KEY`).

### 6.4 What live operation looks like

```
INFO: opportunity { user: 0x…, hf: 0.94, eMode: true, route: v3:500, gross: 612.40, fee: 3.06, gas: 0.01, net: 609.33 }
INFO: simulation PASSED — liquidation call would execute
INFO: public tx sent  hash=0x…            (L2)
INFO: bundle submitted  bundleHash=0x… targetBlock=23100123   (mainnet)
```

Watch the first hours closely. On the explorer, a successful liquidation shows
the `Liquidated` event on your contract with `profitLeftInContract > 0`.

### 6.5 First aid

- **Kill switch**: `Ctrl+C` stops scanning instantly. There is no background
  process once the keeper exits (each action is a single signed tx).
- **Contract stuck/frozen?** Nothing in the contract can act on its own; it
  only moves when your keeper calls `liquidate()` or you sweep.
- **Wallet drained risk**: the key signs txs only from the bot process. Keep
  the balance minimal; the contract holds profits, not the wallet.

---

## Stage 7 — Operating the bot

### 7.1 Keep it running (systemd)

```ini
# /etc/systemd/system/liquidator.service
[Unit]
Description=Aave v3 flash-loan liquidation keeper
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/aave-flashloan-liquidator
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=5
# Hardening
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/home/ubuntu/aave-flashloan-liquidator/data

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now liquidator
journalctl -u liquidator -f          # follow logs
```

(Use `pm2 start npm -- start` if you prefer Node tooling over systemd.)

### 7.2 Collect profits

Profit accumulates **inside the contract** in whatever asset the swap
returned (usually the debt asset). Sweep regularly to your wallet:

```bash
npm run sweep -- --token 0x<debtAssetAddress>          # to your keeper wallet
npm run sweep -- --token 0x<debtAssetAddress> --to 0x<safeWallet>
npm run sweep -- --eth
```

The script refuses to run from a non-owner wallet, so it is safe to re-run.

### 7.3 Tune and maintain

- `MIN_PROFIT_USD` — start high, lower as you learn your chain's race
  dynamics. Raising it is the main lever against losing races.
- `SLIPPAGE_BPS` — 100 (1%) is sensible; raise slightly for thin collateral
  pairs, never go to 0 and never above ~300.
- `HF_ALERT_THRESHOLD` — 1.02–1.05 balances early warning vs wasted deep
  scans.
- Registry grows organically via the live Borrow event stream; restart
  weekly-ish so the reserve config cache (bonuses, E-Mode categories) picks
  up Aave governance changes.
- Keep `DISCORD_WEBHOOK_URL` on in production — the alert includes user, HF,
  E-Mode flag, route, and the full P&L breakdown for every action.

### 7.4 Security hygiene

- The `.env` key = contract owner = your entire operation. Back it up
  offline; treat any copy as radioactive.
- Move swept profits off the keeper wallet promptly; the keeper should hold
  only gas float.
- Before meaningful size, get the contract reviewed — it is a deliberate,
  readable ~200-line reference implementation, but an audit is still the
  standard for funds at risk.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `EXECUTION_MODE=public requires LIQUIDATOR_CONTRACT` | Deploy step skipped on this chain | `npm run deploy` on the same `CHAIN`, then set the env var |
| `simulation reverted` on every candidate | Candidates went stale (normal), or wrong swap router on a custom chain | Normal when racing; if persistent everywhere, verify router overrides (`UNISWAP_V2_ROUTER`, `SWAP_ROUTER02`) against the explorer |
| Flashbots `eth_callBundle failed` | Bundle would revert at current state — someone liquidated first | Expected behavior; you pay nothing. Frequent = your `MIN_PROFIT_USD` is too low for mainnet competition |
| Deploy: `Deployer wallet … has zero balance` | Funding missing on that chain | Fund the keeper address on the SAME network (Stage 0.2) |
| `Could not resolve Aave price oracle` | RPC doesn't match `CHAIN`, or provider outage | Check endpoint/chain pair; try a paid endpoint |
| Seeding takes forever / 429s | Free RPC rate limits on historical `getLogs` | Set `SEED_FROM_BLOCK` closer to tip; the registry self-heals via live events |
| `Unknown chain "…"` | Typo in `CHAIN` | One of: `mainnet`, `sepolia`, `base`, `arbitrum` |
| Opportunity logs show `route: v2` on L2 | V3 quote path unavailable (QuoterV2 mis-set) | Base/Arbitrum defaults are verified; only override `QUOTER_V2` if you changed something |
| Bot silent for days | Quiet market — normal | Verify process uptime (`systemctl status`) and registry growth; lower `HF_ALERT_THRESHOLD` temporarily to confirm scanning |

---

## The economics — what to actually expect

Liquidation profit = **liquidation bonus − flash-loan fee − swap slippage − gas − races lost**.

| Scenario | Gross (bonus) | Flash fee (0.05%) | Gas | Net |
|---|---|---|---|---|
| Base: $25k position, 5% bonus, no E-Mode | $1,250 | $12.50 | <$0.05 | **≈ $1,230** (if you win the race) |
| Base: $2k position, 3% bonus | $60 | $1.00 | <$0.05 | ≈ $58 |
| Mainnet: $10k position, 5% bonus | $500 | $5.00 | $8–30 | $465–487 (if you win the race) |
| Mainnet: $1k position, 5% bonus | $50 | $0.50 | $8–30 | **often negative** — engine correctly skips |

E-Mode positions are the best targets: the 100% close factor means one
transaction can capture the *entire* debt instead of half, roughly doubling
the take per race won.

Honest expectations:

1. **You will lose races.** Every skipped/reverted candidate is the system
   working — you pay only when your transaction actually executes (and on
   Flashbots, only when it succeeds).
2. **L2 first.** Free gas turns lost races from a cost into a non-event.
3. **Position sizing is free.** The engine only fires when net ≥ threshold;
   size risk with `MIN_PROFIT_USD`, not with hope.
4. This stack is a complete, working foundation — latency (colocated nodes),
   user discovery beyond Borrow logs (subgraph), and multi-chain fan-out are
   the known upgrade paths once the basics are printing.
