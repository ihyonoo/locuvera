import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { ethers } from 'ethers';
import ganache from 'ganache';
import solc from 'solc';

const source = fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../contracts/UsageRecordRegistry.sol'),
  'utf8',
);
const compiled = JSON.parse(
  solc.compile(
    JSON.stringify({
      language: 'Solidity',
      sources: { 'UsageRecordRegistry.sol': { content: source } },
      settings: {
        evmVersion: 'berlin',
        optimizer: { enabled: true, runs: 200 },
        viaIR: true,
        outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
      },
    }),
  ),
);
const artifact = compiled.contracts?.['UsageRecordRegistry.sol']?.UsageRecordRegistry;

test('only the designated recorder can write, and only the owner can rotate it', async () => {
  assert.ok(artifact, JSON.stringify(compiled.errors));
  const chain = ganache.provider({
    logging: { quiet: true },
    wallet: { totalAccounts: 3 },
    chain: { hardfork: 'berlin' },
  });
  try {
    const provider = new ethers.BrowserProvider(chain);
    const owner = await provider.getSigner(0);
    const recorder = await provider.getSigner(1);
    const outsider = await provider.getSigner(2);
    const contract = await new ethers.ContractFactory(artifact.abi, artifact.evm.bytecode.object, owner).deploy(
      await recorder.getAddress(),
    );
    await contract.waitForDeployment();

    const record = (signer, id) =>
      contract.connect(signer).recordUsageRecord(id, 1, 2, 'tag', 'room-a', 1, 'room-b', 2, []);
    await assert.rejects(record(outsider, 'forged'));
    await (await record(recorder, 'legitimate')).wait();
    assert.equal((await contract.getUsageRecord('legitimate'))[9], true);
    await assert.rejects(contract.connect(outsider).setRecorder(await outsider.getAddress()));
    await (await contract.setRecorder(await outsider.getAddress())).wait();
    await assert.rejects(record(recorder, 'old-key'));
    await (await record(outsider, 'new-key')).wait();
  } finally {
    await chain.disconnect();
  }
});
