# Ripcord

Emergency withdrawal recovery for [Wildcat V2](https://wildcat.finance) markets.

If a lender's wallet is compromised and there is already a withdrawal queued from it, Ripcord tries, on a
best-effort basis, to execute that withdrawal and get the released funds into a safe wallet in one private,
atomic builder bundle, so nothing watching the public mempool can grab them first. No guarantees, and no
promises.

This repo is the web frontend: a static page and a small read-only proxy sat in front of it.

## What's in here

`hosted/index.html` is the app itself. It reads a market's live state, works out which withdrawal batch the
account is in, walks you through signing the forward transaction offline, and fires the bundle at block
builders. It holds no keys, and it never moves funds on its own.

`hosted/view-proxy.js` is a small Node server with no dependencies, just built-ins. It serves the page and
exposes a same-origin `/read` that forwards a short allow-list of read-only JSON-RPC methods to whatever you
set in `READ_RPC`. Anything that could submit a transaction, it refuses.

`hosted/deploy/` has the Caddy config, a systemd unit, and notes for standing it up.

`scripts/offline-sign.js` is the offline signer for the forward transaction, leg three of the bundle. It is the same code the app embeds and offers for download, kept here as the canonical copy so you can check its SHA-256 against the value the app shows before you run it. It needs only `ethers`; run it in a throwaway offline folder, never where the app is served.

## Running it locally

```bash
READ_RPC=https://your-read-endpoint node hosted/view-proxy.js
# then open http://127.0.0.1:8899
```

You do not need `npm install`; the server only uses Node built-ins (Node 20 or later).

## How it actually works

`executeWithdrawal` in a Wildcat V2 market is permissionless, but it always sends the released asset to
whichever account queued the withdrawal. So Ripcord puts up to four transactions in one block:

0. a plain ETH transfer to the account, optionally, so it can pay the gas for step 3;
1. `repayAndProcessUnpaidWithdrawalBatches(0, N)`, optionally, to apply liquidity already in the market to the batch;
2. `executeWithdrawal(account, expiry)`, to release the asset to the account;
3. a signed ERC-20 transfer moving the released asset from the account to a safe destination.

The first three are permissionless, so any funded wallet can sign them. The last can only be signed by the
account holder, and that happens offline; the page never sees the key. The account pays the gas for that
transfer: a builder rejects it unless the account holds gas limit × max fee in ETH at that point, which is what
step 0 is for. In a live compromise that ETH cannot be sent ahead of time, a sweeper would take it, so it goes
inside the bundle. The bundle goes to builders privately and lands all-or-nothing, so the release cannot be
front-run. The amount in step 3 is what `executeWithdrawal` will actually pay, `normalizedAmountPaid × the
account's share of the batch`, which is fixed once the batch is paid and does not grow with interest.

## The precondition, and what it cannot do

This only helps if a withdrawal has already been requested from the compromised wallet. If the tokens were
moved off to a hostile address before that request went in, there is nothing here, or anywhere, that gets
them back. And because inclusion depends on a builder actually winning the block, it is best-effort; you may
need to resubmit across a few blocks.

## Operator fire script

`scripts/ripcord-fire.js` does from a terminal what the Arm panel does by hand, with the checks in front.
Given the compromised account A, the safe destination B and a gas wallet C whose key it holds, it:

1. checks every leg against the chain before sending anything: signer, nonce, target contract, the forward
   amount against the batch's real payout, and the ETH A must hold to pay leg 3's gas;
2. gives A that ETH, either as an ordinary transfer from C mined first (default; rehearsal only, a sweeper
   takes ETH sent ahead of time) or as leg 0 inside the bundle (`--fund-in-bundle`, the safe path);
3. once the batch has expired, submits the bundle to every relay for the next block and repeats each block
   until B's token balance has risen, A's nonce has moved past leg 3, or `--max-minutes` runs out.

```bash
mkdir ripcord-fire && cd ripcord-fire && npm init -y && npm pkg set type=module && npm i ethers@6
cp /path/to/ripcord/scripts/ripcord-fire.js .
node ripcord-fire.js --rpc https://your-read-endpoint --market 0x… --account 0x… --destination 0x… \
  --leg2 signed-execute.txt --leg3 signed-forward.txt --funder-key-file gas-wallet.key --fund-in-bundle --dry-run
```

`--dry-run` runs the checks and prints the plan without sending. Drop it to fire. It never asks for A's key.

Or let the page drive it: start the script with `--listen` instead of `--leg2/--leg3`, paste the legs in the
page as usual, and press **Fire via local script**. The page hands the legs to `http://127.0.0.1:8787`; the
script runs the same checks, funds, waits for expiry and fires each block, and any preflight problem is
reported back into the page's log.

`scripts/sign-variants.js` pre-signs forward legs across several nonces and fee tiers, so a nonce bump or a
contested block is a file swap rather than an offline signing session under time pressure.
`scripts/supervise.js` runs the fire script and restarts it with the right one when the account's nonce moves.
`scripts/sweep-wallet.js` recovers what is left in the gas wallet afterwards, most of the bond it put up for
leg 0 having gone unspent. `scripts/OPERATOR.md` is the runbook for all of it.

## Security model

Market data is read-only and provided as is, without warranty, so check it against something you trust before
you act on timing. The page never asks for a private key or a seed phrase; signing happens offline, in your
own tooling. Submission goes from your browser straight to the relay endpoints listed in the app, not through
the host serving this page.

## Deploying

See `hosted/deploy/DEPLOY.md`.

## Licence

MIT
