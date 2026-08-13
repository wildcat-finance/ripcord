#!/usr/bin/env node
//
// The read-only proxy that sits in front of the Ripcord page.
//
// It serves the static site and exposes exactly one data path: POST /read, which
// forwards a short allow-list of read-only JSON-RPC methods to an upstream held in
// server env (READ_RPC). That upstream URL never reaches the browser, never shows
// up in client code, and never leaves this process.
//
// What it refuses: anything that submits or broadcasts. eth_sendRawTransaction,
// eth_sendBundle, and everything off the allow-list get turned away. This host
// does not put transactions on-chain. Submitting is the client's business, done
// from the browser straight to whatever relay it chooses.
//
//   READ_RPC=https://your-read-endpoint   (required; kept private, not committed)
//   PORT=8899
//
//   READ_RPC=… node hosted/view-proxy.js

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, extname } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const READ_RPC = process.env.READ_RPC || '';
const PORT = Number(process.env.PORT || 8899);

// Read-only methods, and nothing else: no submit, no broadcast, no state changes.
const ALLOW = new Set([
  'eth_call',
  'eth_getBlockByNumber',
  'eth_blockNumber',
  'eth_chainId',
  'eth_getLogs',
  'eth_getBalance',
  'eth_getTransactionCount',
  'eth_getTransactionByHash',
  'eth_getTransactionReceipt',
  'net_version',
]);

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', (c) => ((d += c), d.length > 2e6 && req.destroy()));
    req.on('end', () => resolve(d));
    req.on('error', reject);
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // The same-origin read path. No CORS headers, since this is not for cross-origin callers.
  if (req.method === 'POST' && url.pathname === '/read') {
    res.setHeader('Content-Type', 'application/json');
    if (!READ_RPC) return res.end(JSON.stringify({ error: { message: 'READ_RPC not configured on the server' } }));
    let body;
    try {
      body = JSON.parse((await readBody(req)) || '{}');
    } catch {
      return res.end(JSON.stringify({ error: { message: 'bad json' } }));
    }
    if (!ALLOW.has(body.method)) {
      return res.end(JSON.stringify({ id: body.id ?? 1, error: { message: `method not permitted here: ${body.method}` } }));
    }
    try {
      const up = await fetch(READ_RPC, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: body.id ?? 1, method: body.method, params: body.params || [] }),
      });
      res.end(await up.text());
    } catch (e) {
      res.end(JSON.stringify({ id: body.id ?? 1, error: { message: 'upstream read failed' } }));
    }
    return;
  }

  // static files
  let p = normalize(url.pathname).replace(/^(\.\.[/\\])+/, '');
  if (p === '/' || p === '') p = '/index.html';
  try {
    const file = await readFile(join(HERE, p));
    const ext = extname(p);
    // Never cache HTML/JS, so an edited build is always the one that actually loads.
    const cache = ext === '.html' || ext === '.js' ? 'no-cache, no-store, must-revalidate' : 'public, max-age=3600';
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': cache });
    res.end(file);
  } catch {
    res.writeHead(404).end('not found');
  }
});

server.listen(PORT, () => {
  console.log(`ripcord view proxy on http://127.0.0.1:${PORT}`);
  console.log(`  read upstream : ${READ_RPC ? '(configured, hidden)' : 'NOT SET, set READ_RPC'}`);
  console.log('  submission    : not handled here (clients submit to their chosen relay directly)');
});
