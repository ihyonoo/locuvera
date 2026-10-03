import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';
import {
  appendRecorderRotation,
  expectedRecorderForRecord,
  requirePrivateKey,
  requireRecorderAddress,
} from './besu-keys.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const deploymentPath = path.join(root, 'deployments', 'usage-registry.json');
const rpcUrl = process.env.BESU_RPC_URL ?? 'http://127.0.0.1:8549';
const newRecorder = requireRecorderAddress(process.env.BESU_NEW_RECORDER_ADDRESS, 'BESU_NEW_RECORDER_ADDRESS');

async function main() {
  const ownerKey = requirePrivateKey('BESU_DEPLOYER_PRIVATE_KEY');
  const deployment = JSON.parse(fs.readFileSync(deploymentPath, 'utf8'));
  fs.accessSync(path.dirname(deploymentPath), fs.constants.W_OK);
  if (
    expectedRecorderForRecord(deployment, null, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER) !==
    ethers.getAddress(deployment.recorder)
  ) {
    throw new Error('기록자 변경 이력이 올바르지 않습니다.');
  }
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const network = await provider.getNetwork();
  if (Number(network.chainId) !== Number(deployment.chainId)) {
    throw new Error('배포 기록과 연결된 체인의 ID가 다릅니다.');
  }
  const owner = new ethers.Wallet(ownerKey, provider);
  const contract = new ethers.Contract(
    deployment.address,
    [
      'function owner() view returns (address)',
      'function recorder() view returns (address)',
      'function setRecorder(address newRecorder)',
    ],
    owner,
  );
  if (
    (await contract.owner()) !== owner.address ||
    (await contract.recorder()) !== ethers.getAddress(deployment.recorder)
  ) {
    throw new Error('계약 소유자 또는 현재 기록자가 배포 기록과 다릅니다.');
  }
  const tx = await contract.setRecorder(newRecorder, { gasPrice: ethers.parseUnits('1', 'gwei'), type: 0 });
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1 || (await contract.recorder()) !== ethers.getAddress(newRecorder)) {
    throw new Error(`기록자 변경을 확인할 수 없습니다. 트랜잭션: ${tx.hash}`);
  }
  const updated = appendRecorderRotation(deployment, newRecorder, receipt.blockNumber, receipt.index);
  const temporaryPath = `${deploymentPath}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(temporaryPath, JSON.stringify(updated, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(temporaryPath, deploymentPath);
  } catch (error) {
    fs.rmSync(temporaryPath, { force: true });
    throw new Error(`온체인 변경 후 배포 기록 저장에 실패했습니다. 트랜잭션 ${tx.hash}로 수동 복구가 필요합니다.`, {
      cause: error,
    });
  }
  console.log(`recorder: ${updated.recorder}`);
  console.log(`transaction: ${tx.hash}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
