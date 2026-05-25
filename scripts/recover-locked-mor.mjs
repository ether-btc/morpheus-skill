#!/usr/bin/env node
/**
 * recover-locked-mor.mjs
 * Recover MOR tokens locked in stakesOnHold via the Diamond's withdrawUserStakes().
 *
 * Usage:
 *   node scripts/recover-locked-mor.mjs [--wallet 0x...] [--session-type 20]
 *
 * Prerequisites:
 *   - ~/.everclaw/wallet.enc exists (v2 encrypted wallet)
 *   - gopass morpheus/wallet-passphrase accessible
 *   - ETH on Base for gas (~0.001 ETH)
 *
 * The wallet passphrase is sourced from gopass:
 *   ~/.local/bin/gopass show morpheus/wallet-passphrase
 */

import { createWalletClient, createPublicClient, http, encodeFunctionData } from 'viem';
import { base } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { execSync } from 'child_process';
import * as fs from 'fs';
import { createDecipheriv } from 'crypto';
import { homedir } from 'os';
import { ENC_FORMAT_V2, deriveEncryptionKey } from './lib/wallet-crypto.mjs';

// --- Config ---
const DIAMOND = '0x6aBE1d282f72B474E54527D93b979A4f64d3030a';
const MOR_TOKEN = '0x7431aDa8a591C955a994a21710752EF9b882b8e3';
const RPC = 'https://mainnet.base.org';
const WALLET_FILE = homedir() + '/.everclaw/wallet.enc';

// Parse CLI args
const args = process.argv.slice(2);
let walletAddress = null;
let sessionType = 20; // default: Type 0 (auto-renewal session)

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--wallet' && args[i + 1]) walletAddress = args[++i].toLowerCase();
  if (args[i] === '--session-type' && args[i + 1]) {
    const val = parseInt(args[++i], 10);
    if (isNaN(val) || val < 0 || val > 255) {
      console.error('❌ --session-type must be 0-255, got:', val);
      process.exit(1);
    }
    sessionType = val;
  }
}

// --- Decrypt wallet ---
const passphrase = execSync('~/.local/bin/gopass show morpheus/wallet-passphrase', { encoding: 'utf8' }).trim();
const blob = fs.readFileSync(WALLET_FILE);

if (blob[0] !== ENC_FORMAT_V2) {
  console.error('❌ Wallet file is not v2 format. Aborting.');
  process.exit(1);
}

const salt     = blob.subarray(1, 33);
const iv       = blob.subarray(33, 49);
const authTag  = blob.subarray(49, 65);
const encrypted = blob.subarray(65);

const encKey = await deriveEncryptionKey(passphrase, salt);
const decipher = createDecipheriv('aes-256-gcm', encKey, iv);
decipher.setAuthTag(authTag);
const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);

// The decrypted private key is a UTF-8 string: "0x" + 64 hex chars
// viem privateKeyToAccount() accepts this exact 66-char string format
const privateKeyStr = decrypted.toString('utf8');
if (!privateKeyStr.startsWith('0x') || privateKeyStr.length !== 66) {
  console.error('❌ Decrypted key has unexpected format. Aborting.');
  process.exit(1);
}

const account = privateKeyToAccount(privateKeyStr);
console.log('Wallet address:', account.address);

// Optionally verify against provided address
if (walletAddress && account.address.toLowerCase() !== walletAddress) {
  console.error(`❌ Address mismatch. File: ${account.address}, Expected: ${walletAddress}`);
  process.exit(1);
}

// --- Query balances before ---
const publicClient = createPublicClient({ chain: base, transport: http(RPC) });
const walletClient = createWalletClient({ account, chain: base, transport: http(RPC) });

const [ethBalance, morBalance] = await Promise.all([
  publicClient.getBalance({ address: account.address }),
  publicClient.readContract({
    address: MOR_TOKEN,
    abi: [{ name: 'balanceOf', type: 'function', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }],
    functionName: 'balanceOf',
    args: [account.address]
  })
]);

console.log('ETH balance:', ethBalance.toString());
console.log('MOR balance before:', morBalance.toString(), `(${Number(morBalance) / 1e18} MOR)`);

if (morBalance === 0n) {
  console.log('⚠️  MOR balance is 0. Nothing to recover.');
  process.exit(0);
}

// --- Build and send transaction ---
const abi = [{ type: 'function', name: 'withdrawUserStakes', inputs: [{ type: 'address' }, { type: 'uint8' }] }];
const data = encodeFunctionData({
  abi,
  args: [account.address, sessionType]
});

console.log(`\nSending withdrawUserStakes(${account.address}, ${sessionType})...`);
console.log('Data:', data);

// Estimate gas before sending
let gasLimit;
try {
  gasLimit = await publicClient.estimateGas({
    to: DIAMOND,
    data,
    value: 0n,
    account: walletClient.account,
    client: walletClient
  });
  gasLimit = gasLimit * 120n / 100n; // 20% buffer
  console.log('Gas estimate:', gasLimit.toString());
} catch (estErr) {
  console.warn('⚠️  Gas estimation failed, using fallback 500000:', estErr.shortMessage || estErr.message);
  gasLimit = 500000n;
}

try {
  const hash = await walletClient.sendTransaction({
    to: DIAMOND,
    data,
    value: 0n,
    gas: gasLimit
  });
  console.log('TX sent:', hash);

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log('Status:', receipt.status === 'success' ? '✅ SUCCESS' : '❌ FAILED');
  console.log('Gas used:', receipt.gasUsed.toString());
  console.log('Block:', receipt.blockNumber.toString());

  if (receipt.status !== 'success') {
    console.error('❌ TX REVERTED. Check Etherscan for revert reason.');
    process.exit(1);
  }

  // Verify new balance
  const newMorBalance = await publicClient.readContract({
    address: MOR_TOKEN,
    abi: [{ name: 'balanceOf', type: 'function', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }],
    functionName: 'balanceOf',
    args: [account.address]
  });
  console.log('\nMOR balance after:', newMorBalance.toString(), `(${Number(newMorBalance) / 1e18} MOR)`);
  const recovered = newMorBalance - morBalance;
  console.log('Recovered:', `${Number(recovered) / 1e18} MOR`);

  // Sanity check
  if (recovered < 0n) {
    console.warn('⚠️  WARNING: Balance decreased. Possible concurrent TX or reading stale state.');
  }
} catch (e) {
  console.error('❌ Transaction failed:', e.shortMessage || e.message);
  process.exit(1);
}
