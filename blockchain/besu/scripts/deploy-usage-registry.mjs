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
const DEPLOYER_PRIVATE_KEY = requirePrivateKey('BESU_DEPLOYER_PRIVATE_KEY');
const RECORDER_ADDRESS = requireSenderAddress();

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
          '*': ['abi', 'evm.bytecode.object'],
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

  return output.contracts['UsageRecordRegistry.sol'].UsageRecordRegistry;
}

async function main() {
  const compiled = compileContract();
  const provider = new ethers.JsonRpcProvider(RPC_URL, {
    name: 'besu-qbft',
    chainId: CHAIN_ID,
  });
  const wallet = new ethers.Wallet(DEPLOYER_PRIVATE_KEY, provider);
  const factory = new ethers.ContractFactory(compiled.abi, compiled.evm.bytecode.object, wallet);

  console.log(`Deploying UsageRecordRegistry to ${RPC_URL} ...`);
  console.log(`deployer: ${wallet.address}`);

  const contract = await factory.deploy(RECORDER_ADDRESS, {
    gasPrice: ethers.parseUnits('1', 'gwei'),
    type: 0,
  });
  const deploymentTx = contract.deploymentTransaction();

  if (!deploymentTx) {
    throw new Error('deployment transaction not found');
  }

  const receipt = await deploymentTx.wait();

  fs.mkdirSync(path.dirname(DEPLOYMENT_PATH), { recursive: true });
  fs.writeFileSync(
    DEPLOYMENT_PATH,
    JSON.stringify(
      {
        contractName: 'UsageRecordRegistry',
        address: await contract.getAddress(),
        chainId: CHAIN_ID,
        rpcUrl: RPC_URL,
        deploymentTxHash: deploymentTx.hash,
        deploymentBlockNumber: receipt?.blockNumber ?? null,
        deployer: wallet.address,
        recorder: RECORDER_ADDRESS,
        recorderHistory: [
          {
            address: RECORDER_ADDRESS,
            fromBlock: receipt?.blockNumber ?? 0,
            fromTransactionIndex: receipt?.index ?? 0,
          },
        ],
      },
      null,
      2,
    ),
  );

  console.log(`contract address: ${await contract.getAddress()}`);
  console.log(`deployment tx: ${deploymentTx.hash}`);
  console.log(`deployment block: ${receipt?.blockNumber ?? 'unknown'}`);
  console.log(`saved deployment: ${DEPLOYMENT_PATH}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
