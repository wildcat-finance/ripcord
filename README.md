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
whichever account queued the withdrawal. So Ripcord puts three transactions in one block:

1. `repayAndProcessUnpaidWithdrawalBatches(0, N)`, optionally, to apply liquidity already in the market to the batch;
2. `executeWithdrawal(account, expiry)`, to release the asset to the account;
3. a signed ERC-20 transfer moving the released asset from the account to a safe destination.

The first two are permissionless, so any funded relayer can sign them. The third can only be signed by the
account holder, and that happens offline; the page never sees the key. The bundle goes to builders privately
and lands all-or-nothing, so the release cannot be front-run.

## The precondition, and what it cannot do

This only helps if a withdrawal has already been requested from the compromised wallet. If the tokens were
moved off to a hostile address before that request went in, there is nothing here, or anywhere, that gets
them back. And because inclusion depends on a builder actually winning the block, it is best-effort; you may
need to resubmit across a few blocks.

## Security model

Market data is read-only and provided as is, without warranty, so check it against something you trust before
you act on timing. The page never asks for a private key or a seed phrase; signing happens offline, in your
own tooling. Submission goes from your browser straight to the relay endpoints listed in the app, not through
the host serving this page.

## Deploying

See `hosted/deploy/DEPLOY.md`.

## Licence

MIT
