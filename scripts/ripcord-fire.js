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
// Two ways to start it:
//   CLI     pass --leg2/--leg3 and it runs steps 1 to 3 straight away.
//   Listen  pass --listen and it waits on http://127.0.0.1:8787 for the page's
//           "Fire via local script" button (or a relay-box entry pointing here).
//           The button posts the pasted legs; the script runs steps 1 to 3 on
//           them and reports preflight problems back into the page's log.
//           Simulate is forwarded to the real relays.
//
// It never asks for A's key. It needs C's key only to sign the funding transfer,
// from --funder-key-file <path> or the FUNDER_KEY environment variable.
//
// Usage:
//   node ripcord-fire.js --rpc <read rpc url> --market 0x… --account 0x… --destination 0x… \
//        (--leg2 <hex or file> --leg3 <hex or file> [--leg1 <hex or file>] | --listen [port]) \
//        [--funder-key-file key.txt | --no-fund] [--fund-in-bundle] [--fund-eth 0.03] \
//        [--relays url,url] [--fb-key-file key.txt] [--expiry 1789716791] \
//        [--simulate] [--dry-run] [--max-minutes 30]
//
//   --dry-run     preflight and plan only; sends nothing (in listen mode: report and stop on each press).
//   --simulate    eth_callBundle at each relay once the batch has expired, before the first submit.
//   --fb-key-file any key, used only to sign the X-Flashbots-Signature header for relays that want one.
//
// Requires ethers v6 next to it:  npm init -y && npm pkg set type=module && npm i ethers@6

import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
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
class Preflight extends Error { constructor(problems) { super(problems.join(' | ')); this.problems = problems; } }

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
      case '--listen': out.listen = v && /^\d+$/.test(v) ? Number(take()) : 8787; break;
      default: fail(`unknown argument ${a}`);
    }
  }
  for (const k of ['rpc', 'market', 'account', 'destination']) if (!out[k]) fail(`--${k} is required`);
  if (!out.listen && !(out.leg2 && out.leg3)) fail('give --leg2 and --leg3, or --listen to take the legs from the page');
  return out;
}

function rawFrom(v) {
  const t = /^0x[0-9a-fA-F]+$/.test(v) ? v : readFileSync(v, 'utf8').trim();
  if (!/^0x[0-9a-fA-F]+$/.test(t)) throw new Error(`not a signed transaction: ${v}`);
  return t;
}
const same = (a, b) => a && b && getAddress(a) === getAddress(b);
const short = (a) => a.slice(0, 8) + '…' + a.slice(-4);
const hostOf = (u) => { try { return new URL(u).host; } catch { return u; } };

async function postRelay(url, method, params, fbSigner) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
  const headers = { 'content-type': 'application/json' };
  if (fbSigner) headers['X-Flashbots-Signature'] = `${fbSigner.address}:${await fbSigner.signMessage(id(body))}`;
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 8000);
  try {
    const res = await fetch(url, { method: 'POST', headers, body, signal: ctl.signal });
    return await res.json().catch(() => ({ error: { message: `HTTP ${res.status}, non-JSON body` } }));
  } catch (e) { return { error: { message: `unreachable: ${e.message}` } }; }
  finally { clearTimeout(t); }
}
const relayText = (j) => j.error ? `error: ${j.error.message || JSON.stringify(j.error)}` : JSON.stringify(j.result);

// ---- chain context: market, asset, batch, payout ----------------------------------
async function setup() {
  const provider = new JsonRpcProvider(args.rpc);
  const chainId = Number((await provider.getNetwork()).chainId);
  const A = getAddress(args.account), B = getAddress(args.destination), M = getAddress(args.market);
  const market = new Contract(M, MARKET, provider);
  const assetAddr = await market.asset();
  const token = new Contract(assetAddr, ERC20, provider);
  const [decimals, symbol] = await Promise.all([token.decimals().then(Number), token.symbol().catch(() => 'tokens')]);
  const fmtTok = (v) => `${formatUnits(v, decimals)} ${symbol}`;
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
  let funder = null;
  const key = args.funderKeyFile ? readFileSync(args.funderKeyFile, 'utf8').trim() : process.env.FUNDER_KEY;
  if (key && !args.noFund) { try { funder = new Wallet(key, provider); } catch { fail('funder key is not a valid private key'); } }
  const fbSigner = args.fbKeyFile ? new Wallet(readFileSync(args.fbKeyFile, 'utf8').trim()) : null;
  log(`relays: ${args.relays.join(', ')}${funder ? ` · funder C ${short(funder.address)}` : ' · no funder key'}`);
  return { provider, chainId, A, B, M, assetAddr, token, expiry, payout, fullyPaid, fmtTok, funder, fbSigner };
}

// ---- name the legs of a raw bundle by what they do -----------------------------------
function classify(ctx, raws) {
  const legs = [], problems = [];
  for (const raw of raws) {
    let tx; try { tx = Transaction.from(raw); } catch (e) { problems.push(`cannot decode a leg (${e.message})`); continue; }
    if (!tx.from) { problems.push('a leg has no signature'); continue; }
    let name;
    if (same(tx.to, ctx.assetAddr) && same(tx.from, ctx.A)) name = 'leg 3 forward';
    else if (same(tx.to, ctx.M) && tx.data.startsWith(EXECUTE_SELECTOR)) name = 'leg 2 execute';
    else if (same(tx.to, ctx.M)) name = 'leg 1 process';
    else if (same(tx.to, ctx.A) && tx.data === '0x' && tx.value > 0n) name = 'leg 0 fund';
    else { problems.push(`unrecognised leg from ${short(tx.from)} to ${tx.to}`); continue; }
    legs.push({ name, raw, tx });
  }
  const order = ['leg 0 fund', 'leg 1 process', 'leg 2 execute', 'leg 3 forward'];
  const idx = legs.map((l) => order.indexOf(l.name));
  if (idx.some((v, i) => i && v <= idx[i - 1])) problems.push(`legs are out of order or duplicated: ${legs.map((l) => l.name).join(', ')}`);
  if (!legs.some((l) => l.name === 'leg 2 execute')) problems.push('no execute leg (leg 2)');
  if (!legs.some((l) => l.name === 'leg 3 forward')) problems.push('no forward leg (leg 3) signed by the account');
  return { legs, problems };
}

// ---- step 1: check every leg against the chain -----------------------------------------
async function preflight(ctx, legs, problems) {
  const { provider, A, B, M, assetAddr, expiry, payout, fmtTok } = ctx;
  let leg3 = null, leg0 = null;
  for (const l of legs) {
    const tx = l.tx;
    const nonce = await provider.getTransactionCount(tx.from);
    const bal = await provider.getBalance(tx.from);
    const need = tx.gasLimit * tx.maxFeePerGas + tx.value;
    log(`${l.name}: from ${short(tx.from)} nonce ${tx.nonce} (chain ${nonce}) → ${short(tx.to)} gas ${tx.gasLimit} maxFee ${formatUnits(tx.maxFeePerGas, 9)} gwei tip ${formatUnits(tx.maxPriorityFeePerGas, 9)} gwei · hash ${tx.hash}`);
    if (tx.type !== 2) problems.push(`${l.name}: not an EIP-1559 transaction`);
    if (Number(tx.chainId) !== ctx.chainId) problems.push(`${l.name}: chainId ${tx.chainId}, rpc is on ${ctx.chainId}`);
    if (tx.nonce !== nonce) problems.push(`${l.name}: nonce ${tx.nonce} but ${short(tx.from)} is at ${nonce}`);
    if (l.name === 'leg 3 forward') {
      leg3 = l;
      let to, amount;
      try { [to, amount] = ERC20.decodeFunctionData('transfer', tx.data); } catch { problems.push('leg 3 is not an ERC-20 transfer'); }
      if (to !== undefined) {
        log(`  leg 3 transfers ${fmtTok(amount)} to ${short(to)}`);
        if (!same(to, B)) problems.push(`leg 3 pays ${to}, not the destination ${B}`);
        if (amount > payout) problems.push(`leg 3 amount ${fmtTok(amount)} exceeds the payout ${fmtTok(payout)}; re-sign for at most the payout`);
        else if (payout - amount > payout / 100n) log(`  note: leaves ${fmtTok(payout - amount)} behind in A`);
      }
      l.gasMoney = tx.gasLimit * tx.maxFeePerGas; // A pays for leg 3 itself
    } else if (l.name === 'leg 0 fund') {
      leg0 = l;
      if (bal < need) problems.push(`leg 0: funder ${short(tx.from)} holds ${formatEther(bal)} ETH, needs ${formatEther(need)}`);
    } else {
      if (l.name === 'leg 2 execute') {
        const argAcct = '0x' + tx.data.slice(34, 74), argExp = parseInt(tx.data.slice(74, 138), 16);
        if (!same(argAcct, A)) problems.push(`leg 2 executes for ${argAcct}, not ${A}`);
        if (argExp !== expiry) problems.push(`leg 2 targets batch ${argExp}, not ${expiry}`);
      }
      if (bal < need) problems.push(`${l.name}: signer ${short(tx.from)} holds ${formatEther(bal)} ETH, needs ${formatEther(need)} for gas`);
    }
  }
  if (!leg3) return { legs, problems, leg3: null, shortfall: 0n, fundWei: 0n };

  // gas money for A: what leg 3 needs up front, minus what A holds and what a pasted leg 0 brings
  const balA = await provider.getBalance(A);
  const have = balA + (leg0 ? leg0.tx.value : 0n);
  const shortfall = leg3.gasMoney > have ? leg3.gasMoney - have : 0n;
  log(`A holds ${formatEther(balA)} ETH${leg0 ? ` + ${formatEther(leg0.tx.value)} from leg 0` : ''} · leg 3 needs ${formatEther(leg3.gasMoney)} ETH up front · shortfall ${formatEther(shortfall)} ETH`);
  let fundWei = 0n;
  if (args.fundEth) fundWei = parseEther(args.fundEth);
  else if (!args.noFund) fundWei = shortfall;
  if (fundWei === 0n && shortfall > 0n) problems.push(`A is short ${formatEther(shortfall)} ETH for leg 3 and funding is off`);
  if (fundWei > 0n) {
    if (!ctx.funder) problems.push('funding needed: give --funder-key-file <path> or set FUNDER_KEY, or pass --no-fund');
    else {
      const fbal = await provider.getBalance(ctx.funder.address);
      const cost = fundWei + 21000n * leg3.tx.maxFeePerGas;
      log(`C ${short(ctx.funder.address)} holds ${formatEther(fbal)} ETH · will send ${formatEther(fundWei)} ETH to A ${args.fundInBundle ? 'inside the bundle as leg 0' : 'as an ordinary transaction first'}`);
      if (fbal < cost) problems.push(`C holds ${formatEther(fbal)} ETH, needs about ${formatEther(cost)}`);
      if (leg0) problems.push('a leg 0 is already in the bundle and A is still short; raise its amount instead of adding a second');
      for (const l of legs) if (same(l.tx.from, ctx.funder.address) && args.fundInBundle) problems.push(`${l.name} is signed by the funder; leg 0 would take its nonce first. Use another gas wallet or re-sign ${l.name} with nonce ${l.tx.nonce + 1}`);
      if (!args.fundInBundle) log('  WARNING: an ordinary transfer to A is visible and sweepable. Fine for a rehearsal, not for a live compromise (use --fund-in-bundle).');
    }
  }
  return { legs, problems, leg3, shortfall, fundWei };
}

// ---- step 2: fund A ------------------------------------------------------------------------
async function fund(ctx, pre) {
  if (pre.fundWei === 0n || !ctx.funder) return null;
  const { provider, chainId, A, funder } = ctx;
  const fee = await provider.getFeeData();
  const maxFee = fee.maxFeePerGas && fee.maxFeePerGas > pre.leg3.tx.maxFeePerGas ? fee.maxFeePerGas : pre.leg3.tx.maxFeePerGas;
  const tip = fee.maxPriorityFeePerGas || pre.leg3.tx.maxPriorityFeePerGas;
  const ftx = { type: 2, chainId, to: A, value: pre.fundWei, gasLimit: 21000n, maxFeePerGas: maxFee, maxPriorityFeePerGas: tip, nonce: await provider.getTransactionCount(funder.address) };
  if (args.fundInBundle) {
    const raw = await funder.signTransaction(ftx);
    log(`leg 0 signed: ${formatEther(pre.fundWei)} ETH C → A, nonce ${ftx.nonce}, rides inside the bundle`);
    return { name: 'leg 0 fund', raw, tx: Transaction.from(raw) };
  }
  const sent = await funder.sendTransaction(ftx);
  log(`funding sent: ${sent.hash} · waiting for it to be mined…`);
  const rc = await sent.wait(1);
  if (!rc || rc.status !== 1) throw new Error(`funding transaction failed (${sent.hash})`);
  log(`funding mined in block ${rc.blockNumber} · A now holds ${formatEther(await provider.getBalance(A))} ETH`);
  return null;
}

// ---- step 3: submit each block until B has the funds -------------------------------------------
async function fire(ctx, txs, leg3Nonce, legNames) {
  const { provider, token, A, B, expiry, fmtTok, fbSigner } = ctx;
  const startB = await token.balanceOf(B);
  log(`B ${short(B)} holds ${fmtTok(startB)} · firing ${txs.length}-leg bundle [${legNames.join(', ')}] each block from expiry`);
  const deadline = Date.now() + args.maxMinutes * 60_000;
  let lastHead = -1, simulated = false, submits = 0;
  while (true) {
    if (Date.now() > deadline) throw Object.assign(new Error(`gave up after ${args.maxMinutes} minutes and ${submits} submissions; B unchanged`), { code: 3 });
    const head = await provider.getBlock('latest');
    if (head.number === lastHead) { await sleep(1500); continue; }
    lastHead = head.number;
    const nowB = await token.balanceOf(B);
    if (nowB > startB) { log(`DONE: B now holds ${fmtTok(nowB)} (+${fmtTok(nowB - startB)}) after ${submits} submission(s)`); return { done: true, submits, received: nowB - startB }; }
    const nonceNow = await provider.getTransactionCount(A);
    if (nonceNow > leg3Nonce) throw Object.assign(new Error(`A's nonce moved to ${nonceNow} but B did not receive funds: leg 3 can no longer land. Check ${short(A)} on Etherscan and re-sign.`), { code: 4 });
    // executeWithdrawal needs block.timestamp > expiry; the next block is ~12 s after this one.
    if (head.timestamp < expiry) {
      const wait = expiry - head.timestamp;
      if (wait <= 60 || wait % 60 < 12) log(`head ${head.number} @ ${head.timestamp} · batch expires in ${wait}s · holding`);
      await sleep(Math.max(500, Math.min(wait, 12) * 1000 - 500));
      continue;
    }
    const target = '0x' + (head.number + 1).toString(16);
    if (args.simulate && !simulated) {
      simulated = true;
      const rs = await Promise.all(args.relays.map((u) => postRelay(u, 'eth_callBundle', [{ txs, blockNumber: target, stateBlockNumber: 'latest' }], fbSigner)));
      rs.forEach((r, i) => log(`  sim ${hostOf(args.relays[i])}: ${relayText(r).slice(0, 300)}`));
    }
    submits++;
    log(`submit #${submits}: ${txs.length}-leg bundle for block ${head.number + 1}`);
    const rs = await Promise.all(args.relays.map((u) => postRelay(u, 'eth_sendBundle', [{ txs, blockNumber: target }], fbSigner)));
    rs.forEach((r, i) => log(`  ${hostOf(args.relays[i])}: ${relayText(r).slice(0, 200)}`));
  }
}

// ---- one full run over a set of raw legs (used by both CLI and listen mode) ---------------------
async function run(ctx, raws) {
  const { legs, problems } = classify(ctx, raws);
  const pre = await preflight(ctx, legs, problems);
  if (pre.problems.length) { for (const p of pre.problems) process.stderr.write(`  ✗ ${p}\n`); throw new Preflight(pre.problems); }
  log('preflight OK');
  if (args.dryRun) { log('dry run, stopping here'); return { dryRun: true, legs: legs.map((l) => l.name) }; }
  const leg0 = await fund(ctx, pre);
  const bundle = [...(leg0 ? [leg0] : []), ...legs];
  return fire(ctx, bundle.map((l) => l.raw), pre.leg3.tx.nonce, bundle.map((l) => l.name));
}

// ---- listen mode: a local JSON-RPC endpoint for the page's button ------------------------------
function listen(ctx) {
  let state = { status: 'idle' };   // idle | firing | done | failed
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type', 'access-control-allow-private-network': 'true', 'access-control-max-age': '600' };
  const reply = (res, code, body) => { res.writeHead(code, { ...cors, 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const srv = createServer(async (req, res) => {
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    if (req.method !== 'POST') return reply(res, 405, { error: 'POST JSON-RPC only' });
    let body = ''; for await (const c of req) body += c;
    let j; try { j = JSON.parse(body); } catch { return reply(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'bad JSON' } }); }
    const rpc = (result) => reply(res, 200, { jsonrpc: '2.0', id: j.id ?? 1, result });
    const rpcErr = (message, code = -32000) => reply(res, 200, { jsonrpc: '2.0', id: j.id ?? 1, error: { code, message } });
    const txs = j.params?.[0]?.txs;
    if (j.method === 'ripcord_status') return rpc(state);
    if (j.method === 'eth_callBundle') {
      if (!Array.isArray(txs) || !txs.length) return rpcErr('bundle missing txs', -32602);
      log(`simulate request from the page: ${txs.length} leg(s) → forwarding to ${args.relays.length} relay(s)`);
      const rs = await Promise.all(args.relays.map((u) => postRelay(u, 'eth_callBundle', j.params, ctx.fbSigner)));
      rs.forEach((r, i) => log(`  sim ${hostOf(args.relays[i])}: ${relayText(r).slice(0, 300)}`));
      const withResults = rs.find((r) => r.result?.results);
      if (withResults) return rpc(withResults.result);
      return rpc({ note: 'no relay returned a simulation', relays: Object.fromEntries(rs.map((r, i) => [hostOf(args.relays[i]), relayText(r).slice(0, 200)])) });
    }
    if (j.method === 'eth_sendBundle' || j.method === 'ripcord_fire') {
      if (!Array.isArray(txs) || !txs.length) return rpcErr('bundle missing txs', -32602);
      if (state.status === 'firing') return rpc({ status: 'firing', note: 'already firing this bundle; watch the terminal. Restart the script to change legs.' });
      if (state.status === 'done') return rpc(state);
      log(`fire request from the page: ${txs.length} leg(s)`);
      try {
        const { legs, problems } = classify(ctx, txs);
        const pre = await preflight(ctx, legs, problems);
        if (pre.problems.length) { for (const p of pre.problems) process.stderr.write(`  ✗ ${p}\n`); return rpcErr(`preflight failed: ${pre.problems.join(' | ')}`); }
        log('preflight OK');
        if (args.dryRun) { log('dry run, not firing'); return rpc({ status: 'dry-run', note: 'preflight OK; script started with --dry-run so nothing was sent', legs: legs.map((l) => l.name), shortfallEth: formatEther(pre.shortfall) }); }
        state = { status: 'firing', legs: legs.map((l) => l.name), started: new Date().toISOString() };
        rpc({ status: 'firing', note: `preflight OK; ${pre.fundWei > 0n ? (args.fundInBundle ? 'leg 0 will ride in the bundle' : `funding A with ${formatEther(pre.fundWei)} ETH first`) : 'no funding needed'}; firing each block from expiry. Watch the terminal.`, legs: legs.map((l) => l.name) });
        (async () => {
          try {
            const leg0 = await fund(ctx, pre);
            const bundle = [...(leg0 ? [leg0] : []), ...legs];
            const r = await fire(ctx, bundle.map((l) => l.raw), pre.leg3.tx.nonce, bundle.map((l) => l.name));
            state = { status: 'done', ...r, received: r.received?.toString() };
          } catch (e) { state = { status: 'failed', error: e.message }; log(`FAILED: ${e.message}`); }
        })();
        return;
      } catch (e) { return rpcErr(e.message); }
    }
    return rpcErr(`method not found: ${j.method}`, -32601);
  });
  srv.listen(args.listen, '127.0.0.1', () => {
    log(`listening on http://127.0.0.1:${args.listen} · in the page press "Fire via local script" (or set that URL as the only relay)`);
    log(`${args.dryRun ? 'DRY RUN: presses are checked, nothing is sent' : 'presses are live'} · funding ${ctx.funder ? (args.fundInBundle ? 'in-bundle leg 0' : 'ordinary transfer from C') : 'off (no funder key)'}`);
  });
}

async function main() {
  const ctx = await setup();
  if (args.listen) return listen(ctx);
  const raws = [args.leg1, args.leg2, args.leg3].filter(Boolean).map(rawFrom);
  try { await run(ctx, raws); }
  catch (e) { fail(e.message, e instanceof Preflight ? 2 : e.code || 1); }
}

main().catch((e) => fail(e.message));
