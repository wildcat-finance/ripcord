# Operator runbook

How to drive a recovery from a terminal, and the things that decide whether it
works. Read this before the batch expires, not while it is expiring.

Throughout: **A** is the compromised account that queued the withdrawal, **B** is
the safe destination, **C** is a gas wallet whose key you hold.

## What actually happens

`executeWithdrawal` is permissionless but always pays the account that queued the
withdrawal, so releasing the asset puts it on A, where a sweeper is waiting. The
bundle removes the gap:

| leg | what | signed by |
|---|---|---|
| 0 | ETH to A, so it can pay leg 3's gas | C, by the fire script |
| 1 | `repayAndProcessUnpaidWithdrawalBatches`, if the batch is not paid | anyone funded |
| 2 | `executeWithdrawal(A, expiry)` | anyone funded |
| 3 | ERC-20 transfer, A to B | A, offline |

A bundle lands all-or-nothing in one block, so nothing can be inserted between
leg 2 and leg 3. Leg 0 is inside it for the same reason: ETH sent to A ahead of
time is taken before you can use it.

Two constraints fall out of this and neither is negotiable:

- **Nothing can be sent before the batch expires.** `executeWithdrawal` requires
  `block.timestamp > expiry`; earlier than that the leg reverts and the builder
  drops the bundle. The expiry is the floor, not a setting.
- **The payout is fixed once the batch is fully paid.** It is
  `normalizedAmountPaid × the account's share`, and it does not grow with
  interest. Leg 3 must move at most that.

## Preparing

A read-only mainnet RPC, and a copy of `ripcord-fire.js` in a folder with
`ethers` beside it:

```bash
mkdir ripcord-fire && cd ripcord-fire && npm init -y && npm pkg set type=module && npm i ethers@6
cp /path/to/ripcord/scripts/ripcord-fire.js .
```

The signed legs go in files, one hex string each: `leg2.txt`, `leg3.txt`. Leg 3
is signed offline with `offline-sign.js`; the fire script never asks for A's key.

The gas wallet C has two rules. It must hold the shortfall plus one transfer at
leg 3's `maxFeePerGas`, which the script computes and refuses without. And with
`--fund-in-bundle` it must not be a wallet that signed another leg, because leg 0
takes its next nonce first and invalidates that leg. The script checks both.

## The dry run

```bash
node ripcord-fire.js --rpc <url> --market 0x… --account 0x… --destination 0x… \
  --leg2 leg2.txt --leg3 leg3.txt --funder-key-file gas-wallet.key --fund-in-bundle \
  --max-minutes <see below> --dry-run
```

It returns before funding and before firing, so nothing leaves the machine. What
to read in the output: the `nonce N (chain N)` pairs must match on every leg, the
leg 3 amount must be at or under the payout, and the shortfall must be covered by
C. Then `preflight OK`.

## Sizing --max-minutes

The default is 30 minutes and **the clock runs during the wait for expiry too**.
Started three hours before expiry with the default, the script gives up an hour
before it would have fired. Set it to the minutes until expiry plus however long
you want to keep bidding afterwards.

It is only a stop, not a commitment: a run that hits it can be restarted, and a
paid batch stays claimable.

## Firing

Drop `--dry-run`. From then until expiry the script sends nothing at all — it
holds, prints a countdown roughly once a minute, and watches A's nonce. `Ctrl+C`
is free during that window. After expiry it submits to every relay each block
until B's balance rises.

`--simulate` runs one `eth_callBundle` immediately before the first submission,
in the same iteration. It costs up to the relay timeout on the single most
valuable block of the run, and tells you little that the relays' own replies will
not. Leave it off for the live run and add it on a restart if you need to know
why a bundle is not landing.

## Contested blocks

If whoever holds A's key is awake, they can build the mirror of your bundle
paying themselves, and only one of the two can land. Builders choose by payment,
which is gas used × effective tip. A leg 3 signed at a 1 gwei tip bids on the
order of a dollar; anyone chasing the release will outbid that without thinking.

Raising the bid means re-signing leg 3 with a higher tip, and `maxFeePerGas × gas
limit` is a bond A must hold up front, so leg 0 and therefore C must cover it.
Two costs worth knowing before you pick a number: the bid is only paid if the
bundle lands, and whatever the bond exceeds the real price stays on A, where the
sweeper gets it.

You cannot outbid an attacker who values the release at its full amount. What you
can do is price out anything semi-automatic, and be armed first: a script already
holding at expiry fires into the first block, and one block is the whole race.

## When A's nonce moves

Leg 3 is dead and the fire script exits 4. Pre-sign the replacements before this
can happen:

```bash
node sign-variants.js --account 0x… --destination 0x… --asset 0x… --amount <units> \
  --nonces 55,56,57 --tiers lo=1/200,md=500/600 --out variants
```

Each file authorises one transfer to B and nothing else, and only one can ever
land, so the grid is safe to keep. Then run the fire script under the supervisor,
which swaps the right file in and restarts on exit 4:

```bash
node supervise.js --variants variants --tier md --total-minutes 540 -- \
  node ripcord-fire.js --rpc <url> --market 0x… --account 0x… --destination 0x… \
    --leg2 leg2.txt --leg3 leg3.txt --funder-key-file gas-wallet.key --fund-in-bundle
```

Exit codes: 2 is a failed preflight, 3 is the time limit, 4 is the nonce. Only 4
is worth a restart, and only that one the supervisor acts on.

## Afterwards

`DONE: B now holds …` is read from the token contract, so it is the confirmation.
Then:

- recover what is left in C with `sweep-wallet.js --rpc <url> --key-file … --to 0x…`;
- delete the gas wallet key and the signed legs;
- treat A as dead. Its remaining dust and the unspent part of the bond belong to
  the sweeper now, and anything sent there later will too.

## One thing to tell everyone involved

Nobody should call `executeWithdrawal` for A outside the bundle. It releases the
asset onto a compromised account with no transfer beside it, which is precisely
the situation the bundle exists to avoid. The same goes for handing the bundle to
a relay you do not trust: leg 2 can be lifted out of it and sent on its own.
