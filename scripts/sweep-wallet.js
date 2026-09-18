#!/usr/bin/env node
//
// Empties an ordinary wallet into another address, keeping back only the gas.
//
// After a bundle lands, the gas wallet still holds the unspent part of the
// reserve it put up for leg 0: maxFeePerGas is a bond the chain requires up
// front, not a cost, so most of it comes back. This moves that remainder out.
//
// It prints the plan and waits for a typed YES before sending. Use it only on a
// wallet whose key is yours to use; it is no help on a compromised one, where a
// plain transfer is exactly what a sweeper is watching for.
//
// Usage:
//   node sweep-wallet.js --rpc <url> --key-file <path> --to 0x… [--gas-limit 21000] [--yes]
//
// Requires ethers v6.

import { readFileSync } from 'node:fs';
import readline from 'node:readline';
import { JsonRpcProvider, Wallet, getAddress, formatEther, formatUnits } from 'ethers';

const fail = (m) => { process.stderr.write(`error: ${m}\n`); process.exit(1); };

const args = { gasLimit: 21000n };
{
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = argv[i + 1];
    const take = () => { if (v === undefined) fail(`${a} needs a value`); i++; return v; };
    switch (a) {
      case '--rpc': args.rpc = take(); break;
      case '--key-file': args.keyFile = take(); break;
      case '--to': args.to = take(); break;
      case '--gas-limit': args.gasLimit = BigInt(take()); break;
      case '--yes': args.yes = true; break;
      default: fail(`unknown argument ${a}`);
    }
  }
  for (const k of ['rpc', 'keyFile', 'to']) if (!args[k]) fail(`--${k === 'keyFile' ? 'key-file' : k} is required`);
}

const provider = new JsonRpcProvider(args.rpc);
const to = getAddress(args.to);

let wallet;
try { wallet = new Wallet(readFileSync(args.keyFile, 'utf8').trim(), provider); }
catch { fail(`${args.keyFile} does not hold a valid private key`); }

const [balance, fee] = await Promise.all([provider.getBalance(wallet.address), provider.getFeeData()]);
const maxFeePerGas = fee.maxFeePerGas, maxPriorityFeePerGas = fee.maxPriorityFeePerGas;
if (!maxFeePerGas) fail('the rpc did not return fee data');

const reserve = args.gasLimit * maxFeePerGas;
process.stdout.write(`from     ${wallet.address}\n`);
process.stdout.write(`to       ${to}\n`);
process.stdout.write(`balance  ${formatEther(balance)} ETH\n`);
process.stdout.write(`gas      ${formatUnits(maxFeePerGas, 9)} gwei maxFee / ${formatUnits(maxPriorityFeePerGas ?? 0n, 9)} gwei tip\n`);

if (balance <= reserve) {
  process.stdout.write(`nothing to do: the balance does not cover ${formatEther(reserve)} ETH of gas\n`);
  process.exit(0);
}

const value = balance - reserve;
process.stdout.write(`reserve  ${formatEther(reserve)} ETH held back for gas\n`);
process.stdout.write(`SENDING  ${formatEther(value)} ETH\n`);

if (!args.yes) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((r) => rl.question('\ntype YES to send, anything else to cancel: ', (a) => { rl.close(); r(a.trim()); }));
  if (answer !== 'YES') { process.stdout.write('cancelled, nothing sent\n'); process.exit(0); }
}

const tx = await wallet.sendTransaction({ type: 2, to, value, gasLimit: args.gasLimit, maxFeePerGas, maxPriorityFeePerGas });
process.stdout.write(`sent     ${tx.hash}\n`);

const receipt = await tx.wait(1);
process.stdout.write(`mined in block ${receipt.blockNumber} · status ${receipt.status}\n`);
process.stdout.write(`left     ${formatEther(await provider.getBalance(wallet.address))} ETH (dust, the gap between the bond and the real price)\n`);
