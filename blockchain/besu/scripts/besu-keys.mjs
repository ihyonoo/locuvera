import { ethers } from 'ethers';

const PUBLISHED_DEV_KEYS = new Set([
  '8f2a55949038a9610f50fb23b5883af3b4ecb3c3bb792cbcefbd1542c692be63',
  'c87509a1c067bbde78beb793e6fa76530b6382a4c0241e5e4a9ec0a0f44dc0d3',
  'ae6ae8e5ccbfb04590405997ee2d52d2b330726137b875053c36d94e974d162f',
]);
const PUBLISHED_DEV_ADDRESSES = new Set([...PUBLISHED_DEV_KEYS].map((key) => new ethers.Wallet(key).address));

export function requirePrivateKey(name, env = process.env) {
  const value = env[name]?.trim();
  if (!value || !/^(?:0x)?[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`${name}에는 별도의 32바이트 개인키가 필요합니다.`);
  }
  if (PUBLISHED_DEV_KEYS.has(value.replace(/^0x/i, '').toLowerCase())) {
    throw new Error(`${name}에 공개된 개발용 개인키를 사용할 수 없습니다.`);
  }
  return value;
}

export function requireRecorderAddress(value, name) {
  value = value?.trim();
  if (!value || !ethers.isAddress(value)) {
    throw new Error(`${name}에 유효한 기록자 주소가 필요합니다.`);
  }
  const address = ethers.getAddress(value);
  if (address === ethers.ZeroAddress) {
    throw new Error(`${name}에 유효한 기록자 주소가 필요합니다.`);
  }
  if (PUBLISHED_DEV_ADDRESSES.has(address)) {
    throw new Error(`${name}에 공개된 개발용 계정 주소를 사용할 수 없습니다.`);
  }
  return address;
}

export function requireSenderAddress(env = process.env, privateKey = null) {
  const address = requireRecorderAddress(env.BESU_SENDER_ADDRESS, 'BESU_SENDER_ADDRESS');
  if (privateKey && new ethers.Wallet(privateKey).address !== address) {
    throw new Error('BESU_SENDER_ADDRESS가 BESU_SENDER_PRIVATE_KEY와 일치하지 않습니다.');
  }
  return address;
}

export function expectedRecorderForRecord(
  deployment,
  _onchainRecord,
  blockNumber,
  transactionIndex,
  env = process.env,
) {
  if (deployment.recorder) {
    if (!Array.isArray(deployment.recorderHistory)) return null;
    if (!Number.isInteger(blockNumber) || !Number.isInteger(transactionIndex)) return null;
    let selected = null;
    let previousBlock = -1;
    let previousIndex = -1;
    for (const entry of deployment.recorderHistory) {
      const { address, fromBlock, fromTransactionIndex } = entry;
      if (
        !ethers.isAddress(address) ||
        !Number.isInteger(fromBlock) ||
        !Number.isInteger(fromTransactionIndex) ||
        fromBlock < previousBlock ||
        (fromBlock === previousBlock && fromTransactionIndex <= previousIndex)
      ) {
        return null;
      }
      if (blockNumber > fromBlock || (blockNumber === fromBlock && transactionIndex >= fromTransactionIndex)) {
        selected = ethers.getAddress(address);
      }
      previousBlock = fromBlock;
      previousIndex = fromTransactionIndex;
    }
    return selected;
  }
  return env.BESU_SENDER_ADDRESS ?? deployment.deployer ?? null;
}

export function appendRecorderRotation(deployment, nextAddress, blockNumber, transactionIndex) {
  const history = deployment.recorderHistory;
  if (!Array.isArray(history) || history.length === 0) {
    throw new Error('기록자 변경 이력이 올바르지 않습니다.');
  }
  const recorder = requireRecorderAddress(nextAddress, 'BESU_NEW_RECORDER_ADDRESS');
  const last = history.at(-1);
  if (
    expectedRecorderForRecord(deployment, null, last.fromBlock, last.fromTransactionIndex) !==
    ethers.getAddress(deployment.recorder)
  ) {
    throw new Error('현재 기록자와 변경 이력이 다릅니다.');
  }
  if (recorder === ethers.getAddress(deployment.recorder)) {
    throw new Error('다른 기록자 주소가 필요합니다.');
  }
  if (
    !Number.isInteger(blockNumber) ||
    !Number.isInteger(transactionIndex) ||
    blockNumber < last.fromBlock ||
    (blockNumber === last.fromBlock && transactionIndex <= last.fromTransactionIndex)
  ) {
    throw new Error('기록자 변경 트랜잭션의 순서가 올바르지 않습니다.');
  }
  return {
    ...deployment,
    recorder,
    recorderHistory: [
      ...history,
      { address: recorder, fromBlock: blockNumber, fromTransactionIndex: transactionIndex },
    ],
  };
}
