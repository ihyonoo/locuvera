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

function compileContract() {
  // 배포 파일에는 ABI만 따로 저장하지 않기 때문에, 전송 시점에 계약을 다시 해석한다.
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

function normalizeMovementPath(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((point, index) => {
    if (!point || typeof point !== 'object') {
      throw new Error(`movementPath[${index}] must be an object`);
    }
    return {
      location: normalizeString(point.location),
      at: normalizeInteger(point.at, `movementPath[${index}].at`),
    };
  });
}

function normalizePayload(value) {
  const payload = JSON.parse(value);
  if (!payload || typeof payload !== 'object') {
    throw new Error('payload must be a JSON object');
  }

  // 검증 가능한 원문 필드만 계약 입력 형태로 고정한다.
  return {
    usageId: normalizeString(payload.usageId),
    checkoutUserId: normalizeInteger(payload.checkoutUserId, 'checkoutUserId'),
    returnUserId: normalizeInteger(payload.returnUserId, 'returnUserId'),
    tagId: normalizeString(payload.tagId),
    checkoutLocation: normalizeString(payload.checkoutLocation),
    checkoutAt: normalizeInteger(payload.checkoutAt, 'checkoutAt'),
    returnLocation: normalizeString(payload.returnLocation),
    returnedAt: normalizeInteger(payload.returnedAt, 'returnedAt'),
    movementPath: normalizeMovementPath(payload.movementPath),
  };
}

/** payload는 stdin으로 들어온다 — 인자로 넘기면 128KB(MAX_ARG_STRLEN)에서 exec가 실패한다.
    인자로 준 경우도 계속 받아, 명령줄에서 직접 돌려볼 수 있게 둔다. */
async function readPayloadInput() {
  const fromArgv = process.argv[2];
  if (fromArgv) return fromArgv;
  if (process.stdin.isTTY) return '';
  // readFileSync(0)은 논블로킹 파이프에서 EAGAIN으로 실패한다 — 스트림으로 읽는다.
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8').trim();
}

async function main() {
  const payloadInput = await readPayloadInput();

  if (!payloadInput) {
    throw new Error('usage: node scripts/record-usage-record.mjs < payload.json');
  }

  if (!fs.existsSync(DEPLOYMENT_PATH)) {
    throw new Error('deployment file not found. run deploy-usage-registry.mjs first');
  }

  const payload = normalizePayload(payloadInput);
  const deployment = JSON.parse(fs.readFileSync(DEPLOYMENT_PATH, 'utf8'));
  const abi = compileContract();
  const provider = new ethers.JsonRpcProvider(RPC_URL, {
    name: 'besu-qbft',
    chainId: CHAIN_ID,
  });
  const wallet = new ethers.Wallet(SENDER_PRIVATE_KEY, provider);
  const contract = new ethers.Contract(deployment.address, abi, wallet);

  // 사용 이력 1건을 체인에 기록하고, 이후 조회에 필요한 앵커 메타데이터를 함께 반환한다.
  const tx = await contract.recordUsageRecord(
    payload.usageId,
    payload.checkoutUserId,
    payload.returnUserId,
    payload.tagId,
    payload.checkoutLocation,
    payload.checkoutAt,
    payload.returnLocation,
    payload.returnedAt,
    payload.movementPath,
    {
      gasPrice: ethers.parseUnits('1', 'gwei'),
      type: 0,
    },
  );
  const receipt = await tx.wait();
  const storedRecord = await contract.getUsageRecord(payload.usageId);

  console.log(
    JSON.stringify(
      {
        ...payload,
        contract: deployment.address,
        sender: wallet.address,
        txHash: tx.hash,
        blockNumber: receipt?.blockNumber ?? null,
        blockHash: receipt?.blockHash ?? null,
        transactionIndex: receipt?.index ?? receipt?.transactionIndex ?? null,
        recordedAt: storedRecord ? Number(storedRecord[7]) : null,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
