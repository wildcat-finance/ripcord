#!/usr/bin/env node
//
// Pre-signs a set of forward legs (leg 3) across several nonces and fee tiers.
//
// A live run has two ways to go wrong that both need a differently signed leg 3:
// the account's nonce moves, or the bundle needs a bigger builder payment to win
// a contested block. Signing the whole grid up front turns either into a file
// swap instead of a fresh offline signing session under time pressure.
//
// Every output authorises exactly one thing: moving the stated amount of the
// stated token to the stated destination. Only one of them can ever land.
//
// Usage:
//   node sign-variants.js --account 0x… --destination 0x… --asset 0x… --amount <units> \
//        [--nonces 55,56,57] [--tiers lo=1/200,md=500/600] [--gas-limit 120000] \
//        [--chain-id 1] [--decimals 6] [--out variants] [--key-file path]
//
//   Tiers are <name>=<tip>/<maxFee>, in gwei. The key comes from --key-file, the
//   PRIVATE_KEY environment variable, or a hidden prompt, and is never written out.
//
// Requires ethers v6.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import readline from 'node:readline';
import { Wallet, Interface, Transaction, getAddress, formatUnits, formatEther } from 'ethers';

const ERC20 = new Interface(['function transfer(address to, uint256 amount) returns (bool)']);

const fail = (m) => { process.stderr.write(`error: ${m}\n`); process.exit(1); };
const gwei = (s) => BigInt(Math.round(Number(s) * 1e9));

function parseArgs(argv) {
  const out = { chainId: 1, decimals: 6, gasLimit: '120000', tiers: 'md=500/600', outDir: 'variants' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = argv[i + 1];
    const take = () => { if (v === undefined) fail(`${a} needs a value`); i++; return v; };
    switch (a) {
      case '--account': out.account = take(); break;
      case '--destination': out.destination = take(); break;
      case '--asset': out.asset = take(); break;
      case '--amount': out.amount = take(); break;
      case '--nonces': out.nonces = take(); break;
      case '--tiers': out.tiers = take(); break;
      case '--gas-limit': out.gasLimit = take(); break;
      case '--chain-id': out.chainId = Number(take()); break;
      case '--decimals': out.decimals = Number(take()); break;
      case '--out': out.outDir = take(); break;
      case '--key-file': out.keyFile = take(); break;
      default: fail(`unknown argument ${a}`);
    }
  }
  for (const k of ['account', 'destination', 'asset', 'amount', 'nonces']) if (!out[k]) fail(`--${k} is required`);
  return out;
}

function parseTiers(spec) {
  const tiers = [];
  for (const part of spec.split(/[\s,]+/).filter(Boolean)) {
    const m = /^([A-Za-z0-9_-]+)=(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/.exec(part);
    if (!m) fail(`bad tier "${part}", expected name=tip/maxFee in gwei`);
    const [, name, tip, max] = m;
    if (Number(max) < Number(tip)) fail(`tier ${name}: maxFee ${max} is below tip ${tip}`);
    tiers.push({ name, tip: gwei(tip), max: gwei(max) });
  }
  if (!tiers.length) fail('no tiers given');
  return tiers;
}

function askHidden(query) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const orig = rl._writeToOutput.bind(rl);
    rl._writeToOutput = (s) => (s.includes(query) ? orig(s) : orig('*'));
    rl.question(query, (ans) => { rl.close(); process.stdout.write('\n'); resolve(ans.trim()); });
  });
}

const args = parseArgs(process.argv.slice(2));
const account = getAddress(args.account);
const destination = getAddress(args.destination);
const asset = getAddress(args.asset);
const amount = BigInt(args.amount);
const gasLimit = BigInt(args.gasLimit);
const tiers = parseTiers(args.tiers);
const nonces = args.nonces.split(/[\s,]+/).filter(Boolean).map(Number);
if (nonces.some((n) => !Number.isInteger(n) || n < 0)) fail('--nonces must be whole numbers');

const key = args.keyFile ? readFileSync(args.keyFile, 'utf8').trim()
  : process.env.PRIVATE_KEY || await askHidden('Paste the private key for the account (input hidden): ');

let wallet;
try { wallet = new Wallet(key); } catch { fail('that does not look like a valid private key'); }
if (wallet.address !== account) fail(`this key controls ${wallet.address}, but --account is ${account}`);

mkdirSync(args.outDir, { recursive: true });
const data = ERC20.encodeFunctionData('transfer', [destination, amount]);

for (const nonce of nonces) {
  for (const tier of tiers) {
    const raw = await wallet.signTransaction({
      type: 2, chainId: args.chainId, nonce, to: asset, value: 0n, data,
      gasLimit, maxFeePerGas: tier.max, maxPriorityFeePerGas: tier.tip,
    });
    const file = join(args.outDir, `leg3-n${nonce}-${tier.name}.txt`);
    writeFileSync(file, raw + '\n');
    const d = Transaction.from(raw); // decode it back as a self-check
    process.stdout.write(`${file}  from ${d.from}  nonce ${d.nonce}  tip ${formatUnits(d.maxPriorityFeePerGas, 9)} gwei`
      + `  maxFee ${formatUnits(d.maxFeePerGas, 9)} gwei  reserve ${formatEther(d.gasLimit * d.maxFeePerGas)} ETH\n`);
  }
}

process.stdout.write(`\nevery file transfers ${formatUnits(amount, args.decimals)} to ${destination}\n`);
process.stdout.write('the account must hold the reserve shown above when the bundle lands; leg 0 is what provides it\n');
