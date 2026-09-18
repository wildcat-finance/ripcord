#!/usr/bin/env node
//
// Keeps ripcord-fire.js running across a nonce bump on the account.
//
// ripcord-fire.js exits 4 when the account's nonce moves past leg 3, because
// that signature can no longer land. On an unattended run that ends the attempt
// silently. This restarts the fire script with a pre-signed leg 3 for the new
// nonce, taken from a directory produced by sign-variants.js.
//
// It leaves the fire script itself untouched, which is the point: the verified
// code stays verified and the retry logic lives outside it.
//
// Usage:
//   node supervise.js --variants <dir> [--tier md] [--total-minutes 540] \
//        [--fire ./ripcord-fire.js] -- <ripcord-fire arguments…>
//
//   Everything after -- goes to the fire script unchanged, except --max-minutes,
//   which is replaced on each start with what is left of --total-minutes. --rpc,
//   --account and --leg3 are read back out of those arguments.
//
//   Exit codes other than 4 stop the supervisor: 2 is a failed preflight and 3
//   is the fire script's own time limit, and neither is fixed by a restart.
//
// Requires ethers v6.

import { spawn } from 'node:child_process';
import { copyFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { JsonRpcProvider } from 'ethers';

const fail = (m) => { process.stderr.write(`error: ${m}\n`); process.exit(1); };
const log = (m) => process.stdout.write(`[supervisor ${new Date().toISOString().slice(11, 19)}] ${m}\n`);

const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
if (sep === -1) fail('put -- before the ripcord-fire arguments');

const own = argv.slice(0, sep);
const passed = argv.slice(sep + 1);

const opts = { tier: 'md', totalMinutes: 540, fire: './ripcord-fire.js' };
for (let i = 0; i < own.length; i++) {
  const a = own[i], v = own[i + 1];
  const take = () => { if (v === undefined) fail(`${a} needs a value`); i++; return v; };
  switch (a) {
    case '--variants': opts.variants = take(); break;
    case '--tier': opts.tier = take(); break;
    case '--total-minutes': opts.totalMinutes = Number(take()); break;
    case '--fire': opts.fire = take(); break;
    default: fail(`unknown argument ${a}`);
  }
}
if (!opts.variants) fail('--variants is required');
if (!existsSync(opts.fire)) fail(`cannot find the fire script at ${opts.fire}`);

const valueOf = (flag) => { const i = passed.indexOf(flag); return i === -1 ? undefined : passed[i + 1]; };
const rpc = valueOf('--rpc'), account = valueOf('--account'), leg3 = valueOf('--leg3');
for (const [flag, v] of [['--rpc', rpc], ['--account', account], ['--leg3', leg3]]) {
  if (!v) fail(`${flag} must be among the arguments after --`);
}

// --max-minutes is ours to set, so drop any copy that was passed through.
const fireArgs = [];
for (let i = 0; i < passed.length; i++) {
  if (passed[i] === '--max-minutes') { i++; continue; }
  fireArgs.push(passed[i]);
}

const run = (minutes) => new Promise((resolve) => {
  const child = spawn(process.execPath, [opts.fire, ...fireArgs, '--max-minutes', String(minutes)], { stdio: 'inherit' });
  child.on('exit', (code, signal) => resolve(signal ? -1 : code ?? 1));
});

const provider = new JsonRpcProvider(rpc);
const deadline = Date.now() + opts.totalMinutes * 60_000;

for (;;) {
  const minutes = Math.round((deadline - Date.now()) / 60_000);
  if (minutes < 1) { log('overall deadline reached, stopping'); break; }

  log(`starting ${basename(opts.fire)} with --max-minutes ${minutes}`);
  const code = await run(minutes);

  if (code === -1) { log('interrupted, stopping'); break; }
  if (code === 0) { log('fire script finished successfully'); break; }
  if (code !== 4) { log(`fire script exited ${code}, not a nonce change: stopping, read its output above`); break; }

  const nonce = await provider.getTransactionCount(account);
  const replacement = join(opts.variants, `leg3-n${nonce}-${opts.tier}.txt`);
  if (!existsSync(replacement)) { log(`account nonce is now ${nonce}, no pre-signed variant for it: stopping`); break; }

  copyFileSync(replacement, leg3);
  log(`account nonce moved to ${nonce}, swapped in ${basename(replacement)}, restarting`);
}
