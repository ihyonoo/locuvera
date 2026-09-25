// 서명으로 발신자를 복원하는 부분만 따로 확인한다.
//
// RPC 노드를 장악한 공격자는 검증이 체인에 묻는 모든 답을 지어낼 수 있다. 네 계층을
// 일관되게 위조하면 계층끼리 어긋나지 않으므로 전부 통과한다. 넘지 못하는 선은 서명뿐이다
// — 기록 계정의 개인키가 없으면 바꿔치기한 내용에 유효한 서명을 붙일 수 없다.
//
// 그래서 RPC가 알려주는 from 필드를 믿지 않고 서명에서 직접 복원한다. 이 테스트는 그
// 복원이 실제로 위조를 걸러내는지를 못박는다.

import assert from 'node:assert/strict';
import test from 'node:test';
import { ethers } from 'ethers';

import { recoverSender, sameAddress } from './verify-usage-records.mjs';

const KEY = '0xae6ae8e5ccbfb04590405997ee2d52d2b330726137b875053c36d94e974d162f';
const OTHER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

async function signedTransaction(key, overrides = {}) {
  const wallet = new ethers.Wallet(key);
  const raw = await wallet.signTransaction({
    type: 0,
    chainId: 1337,
    nonce: 7,
    gasLimit: 200000n,
    gasPrice: 1000000000n,
    to: '0xB69A2BAd08f0939E2156AC302979f693C8FC710b',
    value: 0n,
    data: '0xdeadbeef',
    ...overrides,
  });

  // RPC가 돌려주는 모양으로 바꾼다 — 검증기가 실제로 받는 형태와 같아야 한다.
  const parsed = ethers.Transaction.from(raw);
  return {
    type: '0x0',
    chainId: '0x539',
    nonce: '0x7',
    gas: '0x30d40',
    gasPrice: '0x3b9aca00',
    to: parsed.to,
    value: '0x0',
    input: parsed.data,
    r: parsed.signature.r,
    s: parsed.signature.s,
    v: `0x${parsed.signature.v.toString(16)}`,
  };
}

test('서명에서 복원한 주소가 서명한 계정과 같다', async () => {
  const tx = await signedTransaction(KEY);
  const expected = new ethers.Wallet(KEY).address;

  assert.ok(sameAddress(recoverSender(tx), expected));
});

test('입력 데이터를 바꾸면 복원된 주소가 달라진다', async () => {
  const tx = await signedTransaction(KEY);
  const expected = new ethers.Wallet(KEY).address;

  // 서명은 그대로 두고 내용만 바꾼다 — RPC를 장악한 공격자가 할 수 있는 조작이다.
  const forged = { ...tx, input: '0xcafebabe' };

  assert.ok(!sameAddress(recoverSender(forged), expected));
});

test('다른 계정이 서명한 트랜잭션은 걸러진다', async () => {
  const tx = await signedTransaction(OTHER_KEY);
  const expected = new ethers.Wallet(KEY).address;

  assert.ok(!sameAddress(recoverSender(tx), expected));
});

test('RPC가 알려주는 from 필드는 복원 결과를 바꾸지 못한다', async () => {
  const tx = await signedTransaction(OTHER_KEY);
  const expected = new ethers.Wallet(KEY).address;

  // 공격자가 from에 기대 주소를 적어 보내도 서명에서 복원한 값이 우선한다.
  const spoofed = { ...tx, from: expected };

  assert.ok(!sameAddress(recoverSender(spoofed), expected));
});

test('서명이 깨져 복원할 수 없으면 null을 돌려준다', async () => {
  const tx = await signedTransaction(KEY);
  const broken = { ...tx, r: '0x00', s: '0x00' };

  assert.equal(recoverSender(broken), null);
});

test('주소 비교는 대소문자를 구분하지 않는다', () => {
  const address = '0xf17f52151EbEF6C7334FAD080c5704D77216b732';

  assert.ok(sameAddress(address.toLowerCase(), address.toUpperCase()));
  assert.ok(!sameAddress(address, null));
  assert.ok(!sameAddress(null, null));
});
