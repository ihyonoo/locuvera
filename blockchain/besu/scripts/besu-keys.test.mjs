import assert from 'node:assert/strict';
import test from 'node:test';
import { ethers } from 'ethers';
import {
  appendRecorderRotation,
  expectedRecorderForRecord,
  requirePrivateKey,
  requireRecorderAddress,
  requireSenderAddress,
} from './besu-keys.mjs';

const DEV_KEYS = [
  '8f2a55949038a9610f50fb23b5883af3b4ecb3c3bb792cbcefbd1542c692be63',
  'c87509a1c067bbde78beb793e6fa76530b6382a4c0241e5e4a9ec0a0f44dc0d3',
  'ae6ae8e5ccbfb04590405997ee2d52d2b330726137b875053c36d94e974d162f',
];
const KEY = '0x' + '12'.repeat(32);

test('missing, malformed, or published development keys cannot sign transactions', () => {
  assert.throws(() => requirePrivateKey('BESU_SENDER_PRIVATE_KEY', {}), /BESU_SENDER_PRIVATE_KEY/);
  assert.throws(
    () => requirePrivateKey('BESU_SENDER_PRIVATE_KEY', { BESU_SENDER_PRIVATE_KEY: 'abc' }),
    /BESU_SENDER_PRIVATE_KEY/,
  );
  for (const key of DEV_KEYS) {
    assert.throws(() => requirePrivateKey('BESU_SENDER_PRIVATE_KEY', { BESU_SENDER_PRIVATE_KEY: key }), /개발용/);
  }
  assert.equal(requirePrivateKey('BESU_SENDER_PRIVATE_KEY', { BESU_SENDER_PRIVATE_KEY: KEY }), KEY);
});

test('recorder address must match the configured sender key', () => {
  const address = new ethers.Wallet(KEY).address;
  assert.equal(requireSenderAddress({ BESU_SENDER_ADDRESS: address }, KEY), address);
  assert.throws(() => requireSenderAddress({}, KEY), /BESU_SENDER_ADDRESS/);
  assert.throws(
    () => requireSenderAddress({ BESU_SENDER_ADDRESS: new ethers.Wallet('0x' + '34'.repeat(32)).address }, KEY),
    /일치/,
  );
  for (const key of DEV_KEYS) {
    const publishedAddress = new ethers.Wallet(key).address;
    assert.throws(() => requireSenderAddress({ BESU_SENDER_ADDRESS: publishedAddress }), /공개된 개발용/);
    assert.throws(() => requireRecorderAddress(publishedAddress, 'BESU_NEW_RECORDER_ADDRESS'), /공개된 개발용/);
  }
});

test('verification keeps the original writer valid after an authorized recorder rotation', () => {
  const oldWriter = new ethers.Wallet(KEY).address;
  const newWriter = new ethers.Wallet('0x' + '34'.repeat(32)).address;
  const deployment = {
    recorder: newWriter,
    recorderHistory: [
      { address: oldWriter, fromBlock: 10, fromTransactionIndex: 0 },
      { address: newWriter, fromBlock: 20, fromTransactionIndex: 2 },
    ],
  };
  assert.equal(expectedRecorderForRecord(deployment, { recorder: newWriter }, 19, 0), oldWriter);
  assert.equal(expectedRecorderForRecord(deployment, { recorder: newWriter }, 20, 1), oldWriter);
  assert.equal(expectedRecorderForRecord(deployment, { recorder: oldWriter }, 20, 2), newWriter);
  assert.equal(expectedRecorderForRecord({ deployer: oldWriter }, { recorder: newWriter }, 20, 2), oldWriter);
  assert.equal(
    expectedRecorderForRecord({ deployer: oldWriter }, null, 20, 2, { BESU_SENDER_ADDRESS: newWriter }),
    newWriter,
  );
});

test('a confirmed recorder rotation extends the trusted sender timeline', () => {
  const oldWriter = new ethers.Wallet(KEY).address;
  const newWriter = new ethers.Wallet('0x' + '34'.repeat(32)).address;
  const deployment = {
    recorder: oldWriter,
    recorderHistory: [{ address: oldWriter, fromBlock: 10, fromTransactionIndex: 0 }],
  };

  const rotated = appendRecorderRotation(deployment, newWriter, 20, 2);

  assert.equal(rotated.recorder, newWriter);
  assert.equal(expectedRecorderForRecord(rotated, {}, 20, 1), oldWriter);
  assert.equal(expectedRecorderForRecord(rotated, {}, 20, 2), newWriter);
  assert.throws(() => appendRecorderRotation(rotated, oldWriter, 20, 1), /순서/);
  assert.throws(() => appendRecorderRotation(rotated, newWriter, 21, 0), /다른/);
});
