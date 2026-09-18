#!/usr/bin/env node
//
// OFFLINE forward-transaction signer.
//
// Run this on an air-gapped (offline) machine. It builds and signs ONE
// transaction from the parameters you were given, using your private key, and
// prints the signed transaction as a hex string. By default that is the
// forward leg, an ERC-20 transfer from the account. With "kind": "fund" in the
// parameters it is instead the optional funding leg, a plain ETH transfer TO
// the account from any funded wallet, so the account can pay the forward leg's
// gas. The key is used only
// to sign; it is never written anywhere and never sent over any network. This
// script makes no network connections at all.
//
// You hand back only the signed hex string. That string authorises exactly one
// thing: moving the stated amount of the stated token (or, for the funding leg,
// the stated ETH) to the stated destination. It cannot be altered to do
// anything else.
//
// Usage:
//   node offline-sign.js sign-params.json      (forward leg, from the account)
//   node offline-sign.js fund-params.json      (funding leg, from a gas wallet)
//     - reads the transaction parameters from the JSON file
//     - prompts for your private key (input is masked), or reads PRIVATE_KEY
//       from the environment, or --key-file <path>
//
// Requires the `ethers` package. Prepare a folder WHILE ONLINE:
//   mkdir ripcord-sign && cd ripcord-sign && npm init -y && npm pkg set type=module && npm i ethers@6
// then drop this file and sign-params.json in it and go offline to sign.

import { readFileSync, writeFileSync } from 'node:fs';
import readline from 'node:readline';
import { Wallet, Interface, getAddress, formatUnits, formatEther } from 'ethers';

const ERC20_TRANSFER = new Interface(['function transfer(address to, uint256 amount) returns (bool)']);

function fail(msg) {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
}

function askHidden(query) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const orig = rl._writeToOutput.bind(rl);
    rl._writeToOutput = (s) => (s.includes(query) ? orig(s) : orig('*'));
    rl.question(query, (ans) => {
      rl.close();
      process.stdout.write('\n');
      resolve(ans.trim());
    });
  });
}

async function getKey() {
  const fileArg = process.argv.find((a) => a.startsWith('--key-file='));
  if (fileArg) return readFileSync(fileArg.split('=')[1], 'utf8').trim();
  if (process.env.PRIVATE_KEY) return process.env.PRIVATE_KEY.trim();
  return askHidden('Paste the private key for the account (input hidden): ');
}

async function main() {
  const paramsPath = process.argv[2] || 'sign-params.json';
  let p;
  try {
    p = JSON.parse(readFileSync(paramsPath, 'utf8'));
  } catch (e) {
    fail(`could not read params file "${paramsPath}": ${e.message}`);
  }

  const kind = p.kind === 'fund' ? 'fund' : 'forward';
  const required = ['chainId', 'destination', 'amount', 'nonce', 'gasLimit', 'maxFeePerGas', 'maxPriorityFeePerGas'];
  if (kind === 'forward') required.push('asset');
  for (const k of required) {
    if (p[k] === undefined || p[k] === null || p[k] === '') fail(`params missing field: ${k}`);
  }

  const destination = getAddress(p.destination);
  const amount = BigInt(p.amount);
  const base = {
    type: 2,
    chainId: Number(p.chainId),
    nonce: Number(p.nonce),
    gasLimit: BigInt(p.gasLimit),
    maxFeePerGas: BigInt(p.maxFeePerGas),
    maxPriorityFeePerGas: BigInt(p.maxPriorityFeePerGas),
  };

  let tx, lines, outFile;
  if (kind === 'fund') {
    // Funding leg: a plain ETH transfer that gives the account gas money for the
    // forward leg. Signed by any funded wallet, never by the account itself.
    tx = { ...base, to: destination, value: amount, data: '0x' };
    lines = [
      `  action:              send ${formatEther(amount)} ETH (gas money for the forward leg)`,
      `  to the account:      ${destination}`,
    ];
    outFile = 'signed-fund-tx.txt';
  } else {
    const asset = getAddress(p.asset);
    const decimals = p.decimals != null ? Number(p.decimals) : 6;
    tx = { ...base, to: asset, value: 0n, data: ERC20_TRANSFER.encodeFunctionData('transfer', [destination, amount]) };
    lines = [
      `  token contract:      ${asset}`,
      `  action:              transfer ${formatUnits(amount, decimals)} tokens`,
      `  to destination:      ${destination}`,
    ];
    outFile = 'signed-forward-tx.txt';
  }

  const key = await getKey();
  let wallet;
  try {
    wallet = new Wallet(key);
  } catch {
    fail('that does not look like a valid private key');
  }

  process.stdout.write('\nYou are about to sign this, and ONLY this:\n');
  process.stdout.write(`  from (${kind === 'fund' ? 'funding wallet' : 'your account'}): ${wallet.address}\n`);
  for (const l of lines) process.stdout.write(l + '\n');
  process.stdout.write(`  nonce:               ${tx.nonce}\n`);
  process.stdout.write(`  chainId:             ${tx.chainId} (1 = Ethereum mainnet)\n\n`);

  if (p.expectedFrom && getAddress(p.expectedFrom) !== wallet.address) {
    fail(
      `this key controls ${wallet.address}, but the parameters expect ${getAddress(p.expectedFrom)}. ` +
        `Stop and check you are using the right key.`,
    );
  }

  const signed = await wallet.signTransaction(tx);
  writeFileSync(outFile, signed + '\n');

  process.stdout.write('Signed transaction (this is what you send back):\n\n');
  process.stdout.write(signed + '\n\n');
  process.stdout.write(`Also written to: ${outFile}\n`);
  process.stdout.write('This string is safe to send over a secure channel. It is NOT your key.\n');
  if (kind === 'fund') {
    process.stdout.write('Do not send anything else from this funding wallet until the bundle has landed,\n');
    process.stdout.write('or its nonce will change and this transaction will stop being valid.\n');
  } else {
    process.stdout.write('Do not use this wallet again until told the recovery is complete, or the\n');
    process.stdout.write('nonce will change and this transaction will stop being valid.\n');
  }
}

main().catch((e) => fail(e.message));
