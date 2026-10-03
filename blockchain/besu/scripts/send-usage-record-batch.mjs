import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import solc from 'solc';
import { ethers } from 'ethers';
import { requirePrivateKey, requireSenderAddress } from './besu-keys.mjs';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACT_PATH = path.join(ROOT_DIR, 'contracts', 'UsageRecordRegistry.sol');
const DEPLOYMENT_PATH = path.join(ROOT_DIR, 'deployments', 'usage-registry.json');
const RPC_URL = process.env.BESU_RPC_URL ?? 'http://127.0.0.1:8549';
const CHAIN_ID = Number(process.env.BESU_CHAIN_ID ?? '1337');
const SENDER_PRIVATE_KEY = requirePrivateKey('BESU_SENDER_PRIVATE_KEY');
requireSenderAddress(process.env, SENDER_PRIVATE_KEY);
const GAS_PRICE = ethers.parseUnits('1', 'gwei');
const GAS_LIMIT = 400_000n;
const POLL_INTERVAL_MS = 1_000;
const RECEIPT_TIMEOUT_MS = 120_000;

function compileContract() {
  const source = fs.readFileSync(CONTRACT_PATH, 'utf8');
  const input = {
    language: 'Solidity',
    sources: {
      'UsageRecordRegistry.sol': {
        content: source,
      },
    },
    settings: {
      evmVersion: 'berlin',
      optimizer: {
        enabled: true,
        runs: 200,
      },
      viaIR: true,
      outputSelection: {
        '*': {
          '*': ['abi'],
        },
      },
    },
  };

  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = output.errors ?? [];
  const fatalErrors = errors.filter((item) => item.severity === 'error');

  if (fatalErrors.length > 0) {
    throw new Error(fatalErrors.map((item) => item.formattedMessage).join('\n'));
  }

  return output.contracts['UsageRecordRegistry.sol'].UsageRecordRegistry.abi;
}

function normalizeString(value) {
  return typeof value === 'string' ? value : '';
}

function normalizeInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return parsed;
}

function normalizeRecord(value, index) {
  if (!value || typeof value !== 'object') {
    throw new Error(`record ${index} must be an object`);
  }

  return {
    usageId: normalizeString(value.usageId),
    checkoutUserId: normalizeInteger(value.checkoutUserId, `records[${index}].checkoutUserId`),
    returnUserId: normalizeInteger(value.returnUserId, `records[${index}].returnUserId`),
    tagId: normalizeString(value.tagId),
    checkoutLocation: normalizeString(value.checkoutLocation),
    checkoutAt: normalizeInteger(value.checkoutAt, `records[${index}].checkoutAt`),
    returnLocation: normalizeString(value.returnLocation),
    returnedAt: normalizeInteger(value.returnedAt, `records[${index}].returnedAt`),
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForNextBlock(provider) {
  const startBlock = await provider.getBlockNumber();
  while (true) {
    await sleep(POLL_INTERVAL_MS);
    const currentBlock = await provider.getBlockNumber();
    if (currentBlock > startBlock) {
      return { startBlock, triggerBlock: currentBlock };
    }
  }
}

async function waitForReceipts(provider, txHashes) {
  const startedAt = Date.now();
  const receipts = new Map();

  while (receipts.size < txHashes.length) {
    if (Date.now() - startedAt > RECEIPT_TIMEOUT_MS) {
      throw new Error('timed out while waiting for transaction receipts');
    }

    await Promise.all(
      txHashes.map(async (hash) => {
        if (receipts.has(hash)) {
          return;
        }
        const receipt = await provider.getTransactionReceipt(hash);
        if (receipt) {
          receipts.set(hash, receipt);
        }
      }),
    );

    if (receipts.size < txHashes.length) {
      await sleep(POLL_INTERVAL_MS);
    }
  }

  return txHashes.map((hash) => receipts.get(hash));
}

async function main() {
  const recordsPath = process.argv[2];
  const outputPath = process.argv[3] ?? path.join(ROOT_DIR, 'examples', 'usage-record-batch-50-result.json');

  if (!recordsPath) {
    throw new Error('usage: node scripts/send-usage-record-batch.mjs <records-json-path> [output-json-path]');
  }

  if (!fs.existsSync(DEPLOYMENT_PATH)) {
    throw new Error('deployment file not found. run deploy-usage-registry.mjs first');
  }

  const parsed = JSON.parse(fs.readFileSync(path.resolve(recordsPath), 'utf8'));
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('records file must be a non-empty JSON array');
  }

  const records = parsed.map((item, index) => normalizeRecord(item, index));
  const deployment = JSON.parse(fs.readFileSync(DEPLOYMENT_PATH, 'utf8'));
  const abi = compileContract();
  const provider = new ethers.JsonRpcProvider(RPC_URL, {
    name: 'besu-qbft',
    chainId: CHAIN_ID,
  });
  const wallet = new ethers.Wallet(SENDER_PRIVATE_KEY, provider);
  const contract = new ethers.Contract(deployment.address, abi, wallet);

  const { startBlock, triggerBlock } = await waitForNextBlock(provider);
  const baseNonce = await provider.getTransactionCount(wallet.address, 'pending');

  const signedTransactions = await Promise.all(
    records.map(async (record, index) => {
      const txRequest = await contract.recordUsageRecord.populateTransaction(
        record.usageId,
        record.checkoutUserId,
        record.returnUserId,
        record.tagId,
        record.checkoutLocation,
        record.checkoutAt,
        record.returnLocation,
        record.returnedAt,
      );

      return wallet.signTransaction({
        ...txRequest,
        chainId: CHAIN_ID,
        gasPrice: GAS_PRICE,
        gasLimit: GAS_LIMIT,
        nonce: baseNonce + index,
        type: 0,
      });
    }),
  );

  const responses = await Promise.all(
    signedTransactions.map((signedTransaction) => provider.broadcastTransaction(signedTransaction)),
  );
  const txHashes = responses.map((response) => response.hash);
  const receipts = await waitForReceipts(provider, txHashes);

  const blockNumbers = [...new Set(receipts.map((receipt) => Number(receipt.blockNumber)))];
  const result = {
    recordCount: records.length,
    startBlock,
    triggerBlock,
    baseNonce,
    contractAddress: deployment.address,
    sender: wallet.address,
    txHashes,
    blockNumbers,
    receipts: receipts.map((receipt, index) => ({
      usageId: records[index].usageId,
      txHash: receipt.hash,
      blockNumber: Number(receipt.blockNumber),
      blockHash: receipt.blockHash,
      gasUsed: receipt.gasUsed.toString(),
      status: receipt.status,
      transactionIndex: receipt.index,
    })),
  };

  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
