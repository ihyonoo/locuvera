# Hyperledger Besu QBFT Network

이 디렉터리는 개발용 프라이빗 블록체인 네트워크를 위한 Hyperledger Besu + QBFT 구성 파일을 포함합니다.

구성:

- Validator 4대
- Non-validator RPC 노드 1대
- Docker Compose 기반 단일 호스트 개발 환경

기본 포트:

- `validator1` RPC `8545`, P2P `30303`
- `validator2` RPC `8546`, P2P `30304`
- `validator3` RPC `8547`, P2P `30305`
- `validator4` RPC `8548`, P2P `30306`
- `rpc-node` RPC `8549`, P2P `30307`

앱 연결 기본 엔드포인트:

- `http://127.0.0.1:8549`

## 준비 사항

- Docker 실행 가능 환경
- `openssl`

## 실행 순서

프로젝트 루트에서 아래 순서로 실행합니다.

```bash
bash blockchain/besu/scripts/generate-network.sh
cd blockchain/besu
docker compose up -d
```

네트워크 상태 확인:

```bash
bash blockchain/besu/scripts/check-network.sh
```

중지:

```bash
cd blockchain/besu
docker compose down
```

## 생성 파일

`generate-network.sh` 실행 후 아래 파일들이 생성됩니다.

- `config/genesis.json`
- `validators/validator*/data/key`
- `validators/validator*/data/key.pub`
- `validators/validator*/address`
- `rpc-node/data/key`
- `.env`

위 파일들은 개발용 산출물이므로 Git 추적에서 제외됩니다.

## 수동 사용 완료 레코드 기록

백엔드나 DB를 연결하지 않고, 사용자가 직접 완료된 사용 이력 원문 레코드를 입력해 체인에 기록할 수 있습니다.

준비:

```bash
cd blockchain/besu
npm install
```

컨트랙트 배포:

```bash
cd blockchain/besu
node scripts/deploy-usage-registry.mjs
```

배포 결과는 `deployments/usage-registry.json`에 저장됩니다.

기록자 키를 바꿀 때는 새 주소에 가스 비용을 충전하고, 반납 요청을 처리하는 백엔드를 먼저 정지합니다. 기존 배포자 키로 `BESU_NEW_RECORDER_ADDRESS=<새 주소> npm run rotate:recorder`를 실행하면 온체인 변경과 `deployments/usage-registry.json`의 기록자 변경 이력을 함께 저장합니다. 백엔드의 `BESU_SENDER_PRIVATE_KEY`와 `BESU_SENDER_ADDRESS`를 새 기록자로 바꾼 뒤 재시작하고, 전환 중 누락된 앵커가 없는지 확인합니다. 변경 이력 파일을 잃으면 이전 기록의 작성자 검증에 필요한 시점 정보도 잃으므로 백업합니다.

사용 완료 레코드 기록:

```bash
cd blockchain/besu
node scripts/record-usage-record.mjs '{"usageId":"UH-20260602-0001","checkoutUserId":1,"returnUserId":2,"tagId":"EQ-INF-0001","checkoutLocation":"응급실","checkoutAt":1779294600,"returnLocation":"중환자실","returnedAt":1779298200}'
```

저장값 조회:

```bash
cd blockchain/besu
node scripts/read-usage-record.mjs usage-0001
```

기본 설정:

- RPC: `http://127.0.0.1:8549`
- Chain ID: `1337`
- 기본 서명 계정: genesis에 포함된 개발용 prefunded 계정
- QBFT block period: `30초`

주의:

- 현재 스크립트는 동일한 `usageId`를 다시 기록하지 못하게 막습니다.
- 저장 대상은 완료된 사용 이력의 최소 원문 레코드이며, 이름/부서/직책 같은 표시용 정보는 제외합니다.
- 개발용 계정 키를 사용하므로 운영 환경에는 그대로 쓰면 안 됩니다.
