import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import solc from 'solc';
import { ethers } from 'ethers';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACT_PATH = path.join(ROOT_DIR, 'contracts', 'UsageRecordRegistry.sol');
const DEPLOYMENT_PATH = path.join(ROOT_DIR, 'deployments', 'usage-registry.json');
const RPC_URL = process.env.BESU_RPC_URL ?? 'http://127.0.0.1:8549';
const CHAIN_ID = Number(process.env.BESU_CHAIN_ID ?? '1337');
const EMPTY_TRIE_ROOT = '0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421';

function compileContract() {
  // 검증 스크립트도 계약 ABI가 필요하므로 소스에서 직접 ABI를 만든다.
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

function normalizeNullableString(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function normalizeInteger(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

function sameHex(left, right) {
  return normalizeString(left).toLowerCase() === normalizeString(right).toLowerCase();
}

function normalizeMovementPath(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((point) => point && typeof point === 'object')
    .map((point) => ({
      location: normalizeString(point.location),
      at: normalizeInteger(point.at),
    }));
}

function decodeMovementPathResult(value) {
  if (!value) {
    return [];
  }
  // point.at은 Array.prototype.at()과 이름이 겹쳐 ethers Result에서 undefined가 되므로
  // 반드시 위치 인덱스(point[1])로 읽는다.
  return Array.from(value).map((point) => ({
    location: String(point[0]),
    at: Number(point[1]),
  }));
}

function movementPathEqual(left, right) {
  const a = Array.isArray(left) ? left : [];
  const b = Array.isArray(right) ? right : [];
  if (a.length !== b.length) {
    return false;
  }
  return a.every((point, index) => point.location === b[index].location && point.at === b[index].at);
}

function decodeOnchainRecord(usageId, record) {
  return {
    usageId: String(usageId),
    checkoutUserId: Number(record[0]),
    returnUserId: Number(record[1]),
    tagId: record[2],
    checkoutLocation: record[3],
    checkoutAt: Number(record[4]),
    returnLocation: record[5],
    returnedAt: Number(record[6]),
    recordedAt: Number(record[7]),
    recorder: record[8],
    exists: Boolean(record[9]),
    movementPath: decodeMovementPathResult(record[10]),
  };
}

function normalizeExpectedRecord(value, usageId) {
  if (!value || typeof value !== 'object') {
    return null;
  }
  return {
    usageId: String(value.usageId ?? usageId),
    checkoutUserId: normalizeInteger(value.checkoutUserId),
    returnUserId: normalizeInteger(value.returnUserId),
    tagId: normalizeString(value.tagId),
    checkoutLocation: normalizeString(value.checkoutLocation),
    checkoutAt: normalizeInteger(value.checkoutAt),
    returnLocation: normalizeString(value.returnLocation),
    returnedAt: normalizeInteger(value.returnedAt),
    movementPath: normalizeMovementPath(value.movementPath),
  };
}

function normalizeAnchor(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }
  return {
    txHash: normalizeNullableString(value.txHash),
    blockNumber: normalizeInteger(value.blockNumber),
    blockHash: normalizeNullableString(value.blockHash),
    transactionIndex: normalizeInteger(value.transactionIndex),
    recordedAt: normalizeInteger(value.recordedAt),
  };
}

function compareUsageRecord(left, right) {
  const comparableKeys = [
    'usageId',
    'checkoutUserId',
    'returnUserId',
    'tagId',
    'checkoutLocation',
    'checkoutAt',
    'returnLocation',
    'returnedAt',
  ];
  const mismatchFields = comparableKeys.filter((key) => left?.[key] !== right?.[key]);
  if (!movementPathEqual(left?.movementPath, right?.movementPath)) {
    mismatchFields.push('movementPath');
  }
  return {
    matches: mismatchFields.length === 0,
    mismatchFields,
  };
}

function formatStatus(status, detail = null) {
  switch (status) {
    case 'verified':
      return {
        verification_status: status,
        verification_label: '무결성 검증 성공',
        verification_method:
          'DB 원문과 온체인 원문이 일치하고, 해당 트랜잭션이 포함된 블록의 transactionsRoot 재계산값도 일치합니다.',
        detail,
      };
    case 'not_eligible':
      return {
        verification_status: status,
        verification_label: '사용 중',
        verification_method: detail ?? '아직 반납되지 않아 사용 중인 이력이라 온체인 검증 대상이 아닙니다.',
        detail,
      };
    case 'not_configured':
      return {
        verification_status: status,
        verification_label: '체인 미설정',
        verification_method: detail ?? '온체인 검증 환경이 아직 준비되지 않았습니다.',
        detail,
      };
    case 'onchain_missing':
      return {
        verification_status: status,
        verification_label: '온체인 미기록',
        verification_method: detail ?? 'DB에 있는 반납 이력을 온체인에서 찾지 못했습니다.',
        detail,
      };
    case 'db_mismatch':
      return {
        verification_status: status,
        verification_label: 'DB/온체인 원문 불일치',
        verification_method: detail ?? 'DB 원문과 온체인 원문이 다릅니다.',
        detail,
      };
    case 'tx_input_mismatch':
      return {
        verification_status: status,
        verification_label: '트랜잭션 입력값 불일치',
        verification_method: detail ?? '앵커 트랜잭션의 입력값이 DB 원문과 일치하지 않습니다.',
        detail,
      };
    case 'anchor_unresolved':
      return {
        verification_status: status,
        verification_label: '앵커 트랜잭션 미확인',
        verification_method: detail ?? '해당 이력에 대응되는 트랜잭션 해시를 찾지 못했습니다.',
        detail,
      };
    case 'transaction_missing':
      return {
        verification_status: status,
        verification_label: '트랜잭션 조회 실패',
        verification_method: detail ?? '앵커 트랜잭션 또는 영수증을 체인에서 조회하지 못했습니다.',
        detail,
      };
    case 'tx_not_in_block':
      return {
        verification_status: status,
        verification_label: '블록 내 트랜잭션 불일치',
        verification_method: detail ?? '저장된 트랜잭션 해시가 지정된 블록/인덱스와 일치하지 않습니다.',
        detail,
      };
    case 'tx_sender_mismatch':
      return {
        verification_status: status,
        verification_method: detail ?? '앵커 트랜잭션의 서명에서 복원한 발신자가 기록 계정과 다릅니다.',
        detail,
      };
    case 'transactions_root_mismatch':
      return {
        verification_status: status,
        verification_label: '블록 머클 검증 실패',
        verification_method: detail ?? '블록의 transactionsRoot와 재계산한 값이 일치하지 않습니다.',
        detail,
      };
    default:
      return {
        verification_status: 'chain_error',
        verification_label: '검증 중 오류',
        verification_method: detail ?? '온체인 검증 중 예기치 못한 오류가 발생했습니다.',
        detail,
      };
  }
}

function bigintToMinimalHex(value) {
  const normalized = BigInt(value);
  if (normalized === 0n) {
    return '0x';
  }
  let hex = normalized.toString(16);
  if (hex.length % 2 !== 0) {
    hex = `0${hex}`;
  }
  return `0x${hex}`;
}

function keyNibblesFromIndex(index) {
  // transactionsRoot는 "트랜잭션 인덱스 -> RLP 키" 규칙을 그대로 따라야 재계산 결과가 맞는다.
  const encodedIndex = ethers.encodeRlp(bigintToMinimalHex(index));
  const nibbles = [];
  for (const byte of ethers.getBytes(encodedIndex)) {
    nibbles.push(byte >> 4, byte & 0x0f);
  }
  return nibbles;
}

function compactEncode(nibbles, isLeaf) {
  const flags = isLeaf ? 2 : 0;
  const prefixed = nibbles.length % 2 === 1 ? [flags + 1, ...nibbles] : [flags, 0, ...nibbles];
  const bytes = [];
  for (let index = 0; index < prefixed.length; index += 2) {
    bytes.push((prefixed[index] << 4) | prefixed[index + 1]);
  }
  return ethers.hexlify(Uint8Array.from(bytes));
}

function sharedPrefixLength(keys) {
  if (keys.length === 0) {
    return 0;
  }
  let index = 0;
  while (true) {
    if (index >= keys[0].length) {
      return index;
    }
    const nibble = keys[0][index];
    for (let cursor = 1; cursor < keys.length; cursor += 1) {
      if (index >= keys[cursor].length || keys[cursor][index] !== nibble) {
        return index;
      }
    }
    index += 1;
  }
}

function normalizeRawTransaction(tx) {
  const type = tx.type ? Number(BigInt(tx.type)) : 0;
  const normalized = {
    type,
    chainId: Number(BigInt(tx.chainId)),
    nonce: Number(BigInt(tx.nonce)),
    gasLimit: tx.gas,
    to: tx.to,
    value: tx.value,
    data: tx.input,
    signature: {
      r: tx.r,
      s: tx.s,
      v: Number(BigInt(tx.v)),
    },
  };

  if (type === 0) {
    return {
      ...normalized,
      gasPrice: tx.gasPrice,
    };
  }
  if (type === 1) {
    return {
      ...normalized,
      gasPrice: tx.gasPrice,
      accessList: tx.accessList ?? [],
    };
  }
  if (type === 2) {
    return {
      ...normalized,
      maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
      maxFeePerGas: tx.maxFeePerGas,
      accessList: tx.accessList ?? [],
    };
  }

  return {
    ...normalized,
    gasPrice: tx.gasPrice ?? undefined,
    accessList: tx.accessList ?? undefined,
    maxPriorityFeePerGas: tx.maxPriorityFeePerGas ?? undefined,
    maxFeePerGas: tx.maxFeePerGas ?? undefined,
    maxFeePerBlobGas: tx.maxFeePerBlobGas ?? undefined,
    blobVersionedHashes: tx.blobVersionedHashes ?? undefined,
  };
}

function buildTrieNode(entries) {
  if (entries.length === 1) {
    return {
      type: 'leaf',
      key: entries[0].key,
      value: entries[0].value,
    };
  }

  const prefixLength = sharedPrefixLength(entries.map((entry) => entry.key));
  if (prefixLength > 0) {
    return {
      type: 'extension',
      key: entries[0].key.slice(0, prefixLength),
      child: buildTrieNode(
        entries.map((entry) => ({
          ...entry,
          key: entry.key.slice(prefixLength),
        })),
      ),
    };
  }

  const groups = Array.from({ length: 16 }, () => []);
  let value = '0x';
  for (const entry of entries) {
    if (entry.key.length === 0) {
      value = entry.value;
      continue;
    }
    groups[entry.key[0]].push({
      ...entry,
      key: entry.key.slice(1),
    });
  }

  return {
    type: 'branch',
    children: groups.map((group) => (group.length > 0 ? buildTrieNode(group) : null)),
    value,
  };
}

function encodeTrieNode(node) {
  const childReference = (childNode) => {
    if (!childNode) {
      return '0x';
    }
    const encoded = encodeTrieNode(childNode);
    return ethers.getBytes(encoded).length < 32 ? encoded : ethers.keccak256(encoded);
  };

  if (node.type === 'leaf') {
    return ethers.encodeRlp([compactEncode(node.key, true), node.value]);
  }
  if (node.type === 'extension') {
    return ethers.encodeRlp([compactEncode(node.key, false), childReference(node.child)]);
  }
  return ethers.encodeRlp([...node.children.map(childReference), node.value]);
}

export function recoverSender(tx) {
  // RPC가 알려주는 from 필드는 믿지 않는다 — 노드를 장악한 공격자가 마음대로 적을 수 있다.
  // 서명에서 직접 복원해야 개인키를 가진 계정만 그 값을 만들 수 있다는 성질이 성립한다.
  try {
    return ethers.Transaction.from(normalizeRawTransaction(tx)).from;
  } catch {
    return null;
  }
}

export function sameAddress(left, right) {
  if (!left || !right) {
    return false;
  }
  return left.toLowerCase() === right.toLowerCase();
}

function calculateTransactionsRoot(transactions) {
  // Besu 블록의 transactionsRoot를 동일한 방식으로 다시 계산한다.
  if (!Array.isArray(transactions) || transactions.length === 0) {
    return EMPTY_TRIE_ROOT;
  }
  const entries = transactions.map((tx, index) => ({
    key: keyNibblesFromIndex(index),
    value: ethers.Transaction.from(normalizeRawTransaction(tx)).serialized,
  }));
  return ethers.keccak256(encodeTrieNode(buildTrieNode(entries)));
}

function decodeUsageRecordInput(iface, tx) {
  try {
    const parsed = iface.parseTransaction({ data: tx.input, value: tx.value });
    if (!parsed || parsed.name !== 'recordUsageRecord') {
      return null;
    }
    return {
      usageId: String(parsed.args[0]),
      checkoutUserId: Number(parsed.args[1]),
      returnUserId: Number(parsed.args[2]),
      tagId: String(parsed.args[3]),
      checkoutLocation: String(parsed.args[4]),
      checkoutAt: Number(parsed.args[5]),
      returnLocation: String(parsed.args[6]),
      returnedAt: Number(parsed.args[7]),
      movementPath: decodeMovementPathResult(parsed.args[8]),
    };
  } catch {
    return null;
  }
}

function buildAnchorResult(anchor) {
  return {
    source: anchor?.source ?? null,
    tx_hash: anchor?.txHash ?? null,
    block_number: anchor?.blockNumber ?? null,
    block_hash: anchor?.blockHash ?? null,
    transaction_index: anchor?.transactionIndex ?? null,
    recorded_at: anchor?.recordedAt ?? null,
    transactions_root: anchor?.transactionsRoot ?? null,
    recalculated_transactions_root: anchor?.recalculatedTransactionsRoot ?? null,
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
  const rawInput = await readPayloadInput();
  if (!rawInput) {
    throw new Error('usage: node scripts/verify-usage-records.mjs < payload.json');
  }
  if (!fs.existsSync(DEPLOYMENT_PATH)) {
    throw new Error('deployment file not found. run deploy-usage-registry.mjs first');
  }

  const parsedInput = JSON.parse(rawInput);
  const inputItems = Array.isArray(parsedInput?.items) ? parsedInput.items : [];
  const deployment = JSON.parse(fs.readFileSync(DEPLOYMENT_PATH, 'utf8'));
  // 기록 계정의 주소. 배포 기록에 남은 값을 쓰고, 계정을 바꾼 경우에만 환경변수로 덮는다.
  // 검증기는 개인키를 알 필요가 없다 — 서명이 그 키로 만들어졌는지만 확인하면 된다.
  const expectedSender = process.env.BESU_SENDER_ADDRESS ?? deployment.deployer ?? null;
  const abi = compileContract();
  const iface = new ethers.Interface(abi);
  const provider = new ethers.JsonRpcProvider(RPC_URL, {
    name: 'besu-qbft',
    chainId: CHAIN_ID,
  });
  const contract = new ethers.Contract(deployment.address, abi, provider);

  const eventsByUsageId = new Map();
  // DB에 txHash가 없는 오래된 이력만 이벤트 로그를 보조 수단으로 스캔한다.
  const needsEventLookup = inputItems.some((item) => {
    const expectedRecord = normalizeExpectedRecord(item?.expected, item?.usageId ?? '');
    const anchor = normalizeAnchor(item?.anchor);
    return Boolean(expectedRecord && !anchor?.txHash);
  });
  if (needsEventLookup) {
    const latestBlockNumber = await provider.getBlockNumber();
    const fromBlock = Number(deployment.deploymentBlockNumber ?? 0);
    const chunkSize = 1000;
    for (let start = fromBlock; start <= latestBlockNumber; start += chunkSize) {
      const end = Math.min(start + chunkSize - 1, latestBlockNumber);
      const logs = await contract.queryFilter(contract.filters.UsageRecordStored(), start, end);
      for (const log of logs) {
        const usageId = String(log.args?.usageId ?? '');
        if (!usageId) {
          continue;
        }
        const current = eventsByUsageId.get(usageId);
        if (
          !current ||
          log.blockNumber > current.blockNumber ||
          (log.blockNumber === current.blockNumber && (log.index ?? 0) > (current.logIndex ?? 0))
        ) {
          eventsByUsageId.set(usageId, {
            usageId,
            transactionHash: log.transactionHash,
            blockNumber: log.blockNumber,
            logIndex: log.index ?? 0,
            record: {
              usageId,
              checkoutUserId: Number(log.args?.checkoutUserId ?? 0),
              returnUserId: Number(log.args?.returnUserId ?? 0),
              tagId: String(log.args?.tagId ?? ''),
              checkoutLocation: String(log.args?.checkoutLocation ?? ''),
              checkoutAt: Number(log.args?.checkoutAt ?? 0),
              returnLocation: String(log.args?.returnLocation ?? ''),
              returnedAt: Number(log.args?.returnedAt ?? 0),
            },
          });
        }
      }
    }
  }

  const receiptCache = new Map();
  const blockCache = new Map();
  const onchainRecordCache = new Map();

  const getReceipt = async (txHash) => {
    if (!txHash) {
      return null;
    }
    if (!receiptCache.has(txHash)) {
      receiptCache.set(txHash, await provider.getTransactionReceipt(txHash));
    }
    return receiptCache.get(txHash);
  };

  const getBlock = async (blockHash, blockNumber) => {
    const cacheKey = blockHash || `number:${blockNumber}`;
    if (blockCache.has(cacheKey)) {
      return blockCache.get(cacheKey);
    }
    let block = null;
    if (blockHash) {
      block = await provider.send('eth_getBlockByHash', [blockHash, true]);
    } else if (blockNumber !== null && blockNumber !== undefined) {
      block = await provider.send('eth_getBlockByNumber', [ethers.toQuantity(BigInt(blockNumber)), true]);
    }
    blockCache.set(cacheKey, block);
    return block;
  };

  const getOnchainRecord = async (usageId) => {
    if (!onchainRecordCache.has(usageId)) {
      onchainRecordCache.set(usageId, decodeOnchainRecord(usageId, await contract.getUsageRecord(usageId)));
    }
    return onchainRecordCache.get(usageId);
  };

  const results = [];

  for (const item of inputItems) {
    // 검증은 DB 원문 -> 온체인 원문 -> 트랜잭션 포함 여부 -> 머클루트 재계산 순으로 진행한다.
    const usageId = String(item?.usageId ?? '');
    const expectedRecord = normalizeExpectedRecord(item?.expected, usageId);
    const storedAnchor = normalizeAnchor(item?.anchor);
    const result = {
      usage_id: usageId,
      eligible: Boolean(expectedRecord),
      db_record: expectedRecord,
      onchain_record: null,
      event_record: null,
      onchain_exists: false,
      db_matches_onchain: null,
      db_matches_event: null,
      tx_input_matches_db: null,
      tx_included_in_block: null,
      transactions_root_matches: null,
      mismatch_fields: [],
      tx_sender: null,
      tx_sender_matches: null,
      anchor: buildAnchorResult(storedAnchor),
    };

    if (!expectedRecord) {
      Object.assign(result, formatStatus('not_eligible'));
      results.push(result);
      continue;
    }

    const eventRecord = eventsByUsageId.get(usageId) ?? null;
    if (eventRecord) {
      result.event_record = eventRecord.record;
      const eventCompare = compareUsageRecord(expectedRecord, eventRecord.record);
      result.db_matches_event = eventCompare.matches;
    }

    const onchainRecord = await getOnchainRecord(usageId);
    result.onchain_record = onchainRecord;
    result.onchain_exists = Boolean(onchainRecord.exists);
    result.anchor.recorded_at = onchainRecord.exists ? onchainRecord.recordedAt : result.anchor.recorded_at;

    if (!onchainRecord.exists) {
      Object.assign(result, formatStatus('onchain_missing'));
      results.push(result);
      continue;
    }

    const dbCompare = compareUsageRecord(expectedRecord, onchainRecord);
    result.db_matches_onchain = dbCompare.matches;
    result.mismatch_fields = dbCompare.mismatchFields;
    if (!dbCompare.matches) {
      Object.assign(result, formatStatus('db_mismatch', `불일치 필드: ${dbCompare.mismatchFields.join(', ')}`));
      results.push(result);
      continue;
    }

    let resolvedAnchor = {
      source: storedAnchor?.txHash ? 'db' : null,
      txHash: storedAnchor?.txHash ?? null,
      blockNumber: storedAnchor?.blockNumber ?? null,
      blockHash: storedAnchor?.blockHash ?? null,
      transactionIndex: storedAnchor?.transactionIndex ?? null,
      recordedAt: storedAnchor?.recordedAt ?? onchainRecord.recordedAt,
      transactionsRoot: null,
      recalculatedTransactionsRoot: null,
    };

    if (!resolvedAnchor.txHash && eventRecord) {
      resolvedAnchor = {
        ...resolvedAnchor,
        source: 'event',
        txHash: eventRecord.transactionHash,
        blockNumber: eventRecord.blockNumber,
      };
    }

    if (!resolvedAnchor.txHash) {
      result.anchor = buildAnchorResult(resolvedAnchor);
      Object.assign(result, formatStatus('anchor_unresolved'));
      results.push(result);
      continue;
    }

    const receipt = await getReceipt(resolvedAnchor.txHash);
    if (!receipt) {
      result.anchor = buildAnchorResult(resolvedAnchor);
      Object.assign(result, formatStatus('transaction_missing'));
      results.push(result);
      continue;
    }

    resolvedAnchor = {
      ...resolvedAnchor,
      blockNumber: receipt.blockNumber ?? resolvedAnchor.blockNumber,
      blockHash: receipt.blockHash ?? resolvedAnchor.blockHash,
      transactionIndex: receipt.index ?? receipt.transactionIndex ?? resolvedAnchor.transactionIndex,
    };

    const block = await getBlock(resolvedAnchor.blockHash, resolvedAnchor.blockNumber);
    if (!block || !Array.isArray(block.transactions)) {
      result.anchor = buildAnchorResult(resolvedAnchor);
      Object.assign(result, formatStatus('transaction_missing', '앵커 블록을 조회하지 못했습니다.'));
      results.push(result);
      continue;
    }

    resolvedAnchor.transactionsRoot = block.transactionsRoot ?? null;
    resolvedAnchor.recalculatedTransactionsRoot = calculateTransactionsRoot(block.transactions);
    result.transactions_root_matches = sameHex(
      resolvedAnchor.transactionsRoot,
      resolvedAnchor.recalculatedTransactionsRoot,
    );

    const txIndex = normalizeInteger(resolvedAnchor.transactionIndex);
    const indexedTx = txIndex !== null ? (block.transactions[txIndex] ?? null) : null;
    result.tx_included_in_block = Boolean(indexedTx && sameHex(indexedTx.hash, resolvedAnchor.txHash));
    if (!result.tx_included_in_block) {
      result.anchor = buildAnchorResult(resolvedAnchor);
      Object.assign(result, formatStatus('tx_not_in_block'));
      results.push(result);
      continue;
    }

    // 서명 확인이 먼저다. 입력을 해석해 값을 맞춰 봐야, 그 입력이 기록 계정이 실제로
    // 제출한 것인지가 확인되지 않으면 위조된 트랜잭션도 통과한다.
    result.tx_sender = recoverSender(indexedTx);
    result.tx_sender_matches = expectedSender ? sameAddress(result.tx_sender, expectedSender) : null;
    if (expectedSender && !result.tx_sender_matches) {
      result.anchor = buildAnchorResult(resolvedAnchor);
      Object.assign(result, formatStatus('tx_sender_mismatch', `복원된 발신자: ${result.tx_sender ?? '복원 실패'}`));
      results.push(result);
      continue;
    }

    const decodedInput = decodeUsageRecordInput(iface, indexedTx);
    if (!decodedInput) {
      result.anchor = buildAnchorResult(resolvedAnchor);
      Object.assign(
        result,
        formatStatus('tx_input_mismatch', '앵커 트랜잭션 입력을 UsageRecord로 해석하지 못했습니다.'),
      );
      results.push(result);
      continue;
    }

    const txInputCompare = compareUsageRecord(expectedRecord, decodedInput);
    result.tx_input_matches_db = txInputCompare.matches;
    if (!txInputCompare.matches) {
      result.anchor = buildAnchorResult(resolvedAnchor);
      Object.assign(
        result,
        formatStatus('tx_input_mismatch', `불일치 필드: ${txInputCompare.mismatchFields.join(', ')}`),
      );
      results.push(result);
      continue;
    }

    if (!result.transactions_root_matches) {
      result.anchor = buildAnchorResult(resolvedAnchor);
      Object.assign(result, formatStatus('transactions_root_mismatch'));
      results.push(result);
      continue;
    }

    result.anchor = buildAnchorResult(resolvedAnchor);
    Object.assign(result, formatStatus('verified'));
    results.push(result);
  }

  const summary = results.reduce(
    (acc, item) => {
      acc.total_count += 1;
      if (item.eligible) {
        acc.eligible_count += 1;
      } else {
        acc.not_eligible_count += 1;
      }
      if (item.verification_status === 'verified') {
        acc.verified_count += 1;
      } else if (item.verification_status === 'not_eligible') {
        acc.not_eligible_count += 0;
      } else {
        acc.failed_count += 1;
      }
      acc.status_counts[item.verification_status] = (acc.status_counts[item.verification_status] ?? 0) + 1;
      return acc;
    },
    {
      total_count: 0,
      eligible_count: 0,
      verified_count: 0,
      failed_count: 0,
      not_eligible_count: 0,
      status_counts: {},
    },
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        contract: deployment.address,
        chainId: deployment.chainId ?? CHAIN_ID,
        items: results,
        summary,
      },
      null,
      2,
    ),
  );
}

// 직접 실행할 때만 돈다. 테스트가 이 모듈을 불러올 때 stdin을 기다리며 멈추지 않도록 한다.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
