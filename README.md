# Aave v3 Flash-Loan Liquidation Bot

A keeper bot that monitors Aave v3 lending positions and executes **flash-loan
liquidations** — the protocol-sanctioned mechanism where, when a borrower's
health factor drops below 1, anyone may repay part of their debt and receive
the collateral at a bonus (typically 5–10%).

**v2 features:**
- ⚡ **E-Mode aware** — detects users in E-Mode and applies the 100% close
  factor + category bonus (dramatically larger liquidations per position)
- 🔀 **Dual DEX routing** — quotes both the Uniswap V2 pair and all four V3 fee
  tiers (`SWAP_BACKEND=auto` picks the best real quote; V3 executes via
  SwapRouter02 with no callback plumbing)
- 🌐 **L2 chains** — Base and Arbitrum profiles (verified Pool addresses,
  provider/oracle resolved dynamically from the Pool itself)

> **Scope & ethics note.** This bot implements liquidations only. It does **not**
> and will not implement sandwich/front-running strategies: those extract value
> from specific traders' transactions ("toxic MEV"), are filtered by major
> relays/builders, and have drawn criminal prosecutions (e.g., the 2024 U.S.
> DOJ MEV case). Liquidations, by contrast, are a documented, incentivized part
> of every Aave market — they keep the protocol solvent.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                            src/index.ts                             │
│                 orchestrator: seed → watch → scan → act             │
└──────┬───────────────────┬──────────────────┬───────────────────────┘
       │                   │                  │
┌──────▼──────┐    ┌───────▼───────┐  ┌───────▼────────┐
│ monitor/    │    │ strategy/     │  │ executor/      │
│ registry    │    │ reserves.ts   │  │ tx.ts          │──► FlashLoanLiquidator
│ (Borrow log │    │ (bonus, decs, │  │ flashbots.ts   │      (Solidity, on-chain)
│  seed+stream│    │  token addrs) │  │ (bundle/relay) │       flashLoan →
│  users.json)│    │ liquidation.ts│  │ index.ts       │       liquidationCall →
│ scanner.ts  │    │ (pair picking │  │ (mode dispatch)│       withdraw → swap →
│ (multicall  │    │  + P&L math)  │  └────────────────┘       repay
│  HF batches)│    └───────────────┘
└─────────────┘
       │ alerts: Discord webhook (opportunities, submissions, errors)
```

**Liquidation flow executed on-chain (single atomic tx):**

1. Flash-loan the *debt asset* from the Aave Pool (premium 0.05%).
2. `Pool.liquidationCall(...)` — repay the borrower's debt, receive aTokens.
3. `Pool.withdraw(...)` — redeem aTokens to underlying collateral.
4. Swap collateral → debt asset: Uniswap **V2** (`poolFee=0`) or **V3** via
   SwapRouter02 (`poolFee` = fee tier), `minCollateralOut` slippage guard
   enforced on-chain against a real pre-trade quote.
5. Pool pulls flash loan + premium; leftover = profit, sweepable by the owner.

**E-Mode handling (bot-side math):**

- `Pool.getUserEMode(user)` → category X; each reserve's category is decoded
  from its configuration bitmap (bits 80–87).
- If user category == collateral category → **close factor 100%** (vs 50%)
  and the **category's liquidation bonus** (e.g. 1% for the ETH-correlated
  category) replaces the reserve's bonus.
- Net effect: a full-position liquidation instead of half — usually the
  difference between unprofitable and profitable.

**Route selection (`SWAP_BACKEND`):**

- `v2` — Uniswap V2 pair quote (`getAmountsOut`)
- `v3` — best of the 100/500/3000/10000 fee tiers via QuoterV2
- `auto` *(default)* — quote everything available, take the best output;
  gracefully falls back when a router/quoter isn't configured on the chain

**Chains:**

| Chain       | Aave v3 Pool (verified)                    | Notes                          |
|-------------|--------------------------------------------|--------------------------------|
| Ethereum    | `0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2` | deepest markets, most bots   |
| Sepolia     | `0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951` | testnet — start here         |
| Base        | `0xA238Dd80C259a72e81d7e4664a9801593F98d1c5` | low fees, fewer bots         |
| Arbitrum    | `0x794a61358D6845594F94dc1DB02A252b5b4814aD` | deepest L2 market            |

Oracle + data provider + addresses-provider are resolved **dynamically from
the Pool contract** at startup — the Pool address is the only anchor.
Uniswap router addresses for L2s are commonly-cited same-address deployments:
verify them on the chain's explorer (they're flagged `routerVerified: false`
in `src/chains.ts`, and `dry-run` will surface any wrong address as a failed
quote, never as lost funds).

## Repository layout

```
contracts/FlashLoanLiquidator.sol   on-chain executor (deploy this)
src/index.ts                        entrypoint / loop
src/config.ts                       env parsing, viem clients
src/chains.ts                       address registry + dynamic resolution
src/abi.ts                          ABI fragments
src/monitor/registry.ts             borrower registry (seed + live stream + disk)
src/monitor/scanner.ts              batched health-factor scans (multicall)
src/strategy/reserves.ts            reserve config cache (bonus/decimals/tokens)
src/strategy/liquidation.ts         profitability engine (close factor, bonus, gas)
src/executor/tx.ts                  calldata + fee building
src/executor/flashbots.ts           Flashbots relay client (eth_sendBundle)
src/executor/index.ts               mode dispatch: dry-run | public | private
src/alerts/webhook.ts               Discord alerts
src/util/math.ts                    unit math (usd8, bonus, close factor)
scripts/simulate-example.ts         offline unit-economics sanity check
```

## Quickstart (Sepolia — do this first)

```bash
# 1. Install
npm install

# 2. Generate a dedicated burner keeper wallet
npm run new-wallet

# 3. Configure
cp .env.example .env
#    set CHAIN=sepolia, RPC_URL_HTTP, RPC_URL_WS, PRIVATE_KEY (from new-wallet)

# 4. Sanity-check the math offline (no RPC needed)
npm run simulate

# 5. One scanning pass, dry-run mode (no txs)
npm run scan-once

# 6. Continuous monitoring
npm start
```

In `dry-run` mode the bot logs + Discord-alerts opportunities without spending
anything. Leave it running for a few days to observe real opportunity flow.

**➡ Full go-live walkthrough (wallet → funding → deploy → fork rehearsal →
live on Base/Arbitrum/mainnet → ops): see [RUNBOOK.md](RUNBOOK.md).**

## Deploying the contract

Built-in, no external tooling required (compiles with solc-js in-process):

```bash
npm run compile   # compile-only sanity check (no RPC)
npm run deploy    # compile + deploy to the chain in CHAIN
```

The script prints the exact `LIQUIDATOR_CONTRACT=…` line to paste into `.env`,
and saves a deployment record to `data/deployment-<chain>.json`.

Prefer Foundry? `forge create contracts/FlashLoanLiquidator.sol:FlashLoanLiquidator
--rpc-url $RPC_URL_HTTP --private-key $PRIVATE_KEY --constructor-args $AAVE_POOL`
is equivalent — the constructor takes the Aave Pool address of that chain.

The wallet that deploys becomes the contract owner and must be the same
`PRIVATE_KEY` the bot uses to call `liquidate()`.

## Executing for real

| Mode       | Behavior                                                        |
|------------|-----------------------------------------------------------------|
| `dry-run`  | Simulate via `estimateGas` (real `eth_call`), alert, no tx.     |
| `private`  | Sign tx → Flashbots bundle for block N+1 (`eth_callBundle` pre-check). Recommended: private submission prevents other bots frontrunning *your* liquidation. |
| `public`   | Broadcast to the mempool. Simple, but race-exposed.             |

Suggested progression (detailed in [RUNBOOK.md](RUNBOOK.md)): `dry-run` (days)
→ mainnet-fork rehearsal with anvil (free, full execution) → **Base/Arbitrum
`public`** (cheap gas, low competition) → mainnet `private` (Flashbots) with
`MIN_PROFIT_USD` set high. Never run `public` mode on mainnet — mempool
copy-bots will duplicate your liquidation with a higher tip.

Sweep profits from the contract back to your wallet with
`npm run sweep -- --token 0x<debtAsset>`.

## Configuration reference

See `.env.example` — every knob is documented there. Highlights:

- `MIN_PROFIT_USD` — net-profit gate (after flash fee, slippage haircut, gas).
- `HF_ALERT_THRESHOLD` — watchlist trigger (e.g. `1.05` = deep-scan users below 105% HF).
- `SWAP_BACKEND` — `v2` | `v3` | `auto` (default) route selection.
- `SLIPPAGE_BPS` — max swap slippage, applied to the best quote and enforced
  on-chain via `minCollateralOut`.
- `GAS_UNITS_ESTIMATE` — used when no contract is deployed for real simulation.
- Address overrides: `AAVE_POOL`, `AAVE_ORACLE`, `AAVE_DATA_PROVIDER`,
  `UNISWAP_V2_ROUTER`, `SWAP_ROUTER02`, `QUOTER_V2`. The oracle/provider are
  resolved from the Pool; **verify router addresses on L2s before executing**.
- On L2s the gas estimate excludes the small L1 data-fee component — keep
  `MIN_PROFIT_USD` as a buffer.

## Honest expectations

- **This is a competitive latency game.** Large liquidations on mainnet are
  contested by professional searchers with colocated nodes. Your edge as a
  newcomer is usually smaller/longer-tail positions, **L2s (Base/Arbitrum)**,
  or niche markets.
- **E-Mode is where the margin is**: 100% close factor turns "liquidate half a
  position" into "liquidate the whole position" — with the same fixed costs.
- **Profit math:** gross ≈ debtCovered × (bonus − 1), refined by the actual
  DEX quote for your size. Small positions are often unprofitable after gas —
  the engine measures this honestly and skips them.
- **The registry approach is probabilistic**: seeding from recent `Borrow`
  events covers active borrowers; very old dormant positions may be missed
  until they interact again. (Extension point: swap in a subgraph data source.)
- **No guarantee of profit.** This is infrastructure, not an investment product.

## Security checklist before mainnet

- [ ] Verify the Pool address for your chain (table above) on the explorer.
- [ ] Verify Uniswap V2 router / SwapRouter02 / QuoterV2 on your chain
      (`routerVerified: false` entries in `src/chains.ts`).
- [ ] Get `FlashLoanLiquidator.sol` reviewed by someone competent (it holds funds).
- [ ] Dedicated hot wallet with minimal balance; owner key never used elsewhere.
- [ ] Start with `dry-run`, then tiny `MIN_PROFIT_USD`-gated attempts.
- [ ] Monitor: the bot Discord-alerts every opportunity, submission, and failure.
- [ ] E-Mode: engine reads categories on-chain; no configuration needed.

## Extending

- **Multi-hop V3** (no direct pool): encode a `bytes` path and use SwapRouter02
  `exactInput` — the current build covers direct pairs, which is where most
  liquidation volume lives.
- **More chains**: add an entry in `src/chains.ts` (Aave v3 is on Optimism,
  Polygon, Avalanche, Metis, Gnosis, ...). Only the Pool address is required —
  everything else resolves itself.
- **Subgraph user source**: replace/augment the registry with The Graph for
  full historical coverage.
- **Isolation mode / siloed markets**: check `debtCeiling` before executing.
