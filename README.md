# OpenclawSecretary-Back

Gmail、Google Calendar、HUD承認フローを提供するExpress/PostgreSQLバックエンドです。API契約は`docs/api/openapi.yaml`、DBの正本は`migrations/`です。

## 主な機能

- Google ID tokenとservice account OIDCの分離認証
- active user・active membership・active BUによるresource認可
- Gmail Pub/Sub Push、1時間フォールバックpolling、承認送信、送信結果reconciliation
- Cloud DLP匿名化後のGemini分析、Flash-Lite優先ルーティング、日次request上限
- Calendarの参加者別承認、transactional outbox、冪等実行
- OAuth state・PKCE・nonce保存と単回利用handoff。ID tokenのnonce claim欠落拒否は未完了
- KMSを使用したapproval token、OAuth payload、PIIの封筒暗号化
- FAQ reviewer権限、候補承認、直接FAQ登録
- PII retention、dead-letter保持、管理者replay
- IAP検証Gatewayと、pre-login redeemだけを公開するAuth Bootstrap
- Cloud SQL Connectorによるautomatic IAM DB authentication

## セットアップ

Node.js 22以降とPostgreSQL 15以降が必要です。FAQ/RAG用にpgvector extensionも使用します。

```powershell
npm ci
npm run migrate
npm run check
npm start
```

環境変数は`.env.example`を参照してください。本番環境では、OAuth client secretとユーザーのrefresh tokenをGoogle Secret Managerへ保存します。本番DB接続は`INSTANCE_CONNECTION_NAME`、`DB_NAME`、`DB_USER`からCloud SQL Connectorを構成し、`DATABASE_URL`は使用できません。

processごとの起動commandは次のとおりです。

```powershell
npm start                 # private API/runtime
npm run start:gateway     # IAP protected browser/API gateway
npm run start:bootstrap   # public handoff redeem boundary
```

## 検証

```powershell
npm run test
npm run check:openapi
npm run check:routes
```

`check:routes`はOpenAPIのmethod/pathとExpress handlerを照合し、未実装または未文書のルートがあれば失敗します。
`check:review`は3リポジトリ横断レビュー台帳の固定ID、状態、出力形式を検証します。現行の未解決事項は`docs/reviews/review-register.md`を参照してください。

## 現在のリリース判定

2026-07-21時点のproduction判定は`BLOCKED`です。ローカルbaselineは46 tests、OpenAPI 47 paths/49 operations、route coverage 49/49を通過していますが、次のBack担当項目が未完了です。

- `CR-AUTH-001`: OAuth ID tokenのnonce claim欠落をfail-closedで拒否する。
- `CR-FRONT-CLAIM-001`: ticket/detail/eventからraw claimant IDを除きcaller-relative DTOへ統一する。
- `CR-CAL-001/002`: Calendar scope、freeBusy planner、実行直前revalidationを実装する。
- `CR-DWD-001`、`CR-RAG-001`、`CR-API-001/002`: 固定台帳の受入条件を満たす。
- `CR-AI-001`: 実DLP/Vertexのstaging検証と、生成した暗号化reply draftから承認可能なGmail draftへの接続を完了する。
- `CR-INF-SUPPLY-001`: 4 container imageのpush、SBOM/provenance、cosign署名producer workflowを追加する。

状態、severity、横断受入条件は`docs/reviews/review-register.md`だけを正とし、READMEでは再採番しません。

## 低コストPilot

初期条件は2ユーザー、1日30メールを想定します。PilotではGmail Pushを主経路、1時間pollingを欠落時の保険とし、Cloud Runはscale-to-zero、Cloud SQLは`db-g1-small`/ZONALを使用します。AIは既定無効で、Terraformから有効化した場合もFlash-Liteを優先し、必要時だけFlashへ昇格し、DBの日次上限でrequest数を強制します。

Terraform側の月額予算通知は既定7,000円です。予算通知は課金を停止しないため、10,000円上限を守るには日次AI上限、Cloud Run最大instance数、Billing予算alertを同時に運用します。REGIONAL HAとminimum instanceを要求するproduction guardは緩和しません。

## Migration

Migration runnerはPostgreSQL advisory lockで並列適用を防止し、適用済みファイルのSHA-256 checksumを検証します。一度適用したmigrationは変更せず、新しい連番ファイルを追加してください。

Dockerではruntime、Gateway、Auth Bootstrap、migrationを分離しています。

```powershell
docker build --target runtime -t openclaw-secretary-back .
docker build --target gateway -t openclaw-secretary-gateway .
docker build --target auth-bootstrap -t openclaw-secretary-auth-bootstrap .
docker build --target migrate -t openclaw-secretary-migrate .
```

## 構成

- `src/api-server.js`: HTTP APIとinternal worker endpoint
- `src/gateway-server.js`: IAP JWT検証とprivate Backへのservice OIDC proxy
- `src/auth-bootstrap-server.js`: Electron main向けhandoff redeemの限定公開server
- `src/db-connection.js`: local接続とCloud SQL IAM接続の構成
- `src/auth/`: Google token検証とresource認可
- `src/providers/`: Google OAuth、Gmail、Calendar adapter
- `src/services/`: domain transactionと状態遷移
- `src/crypto/`: Cloud KMSをKEKに使用するAES-256-GCM封筒暗号
- `migrations/`: PostgreSQL schema migration
- `test/`: HTTP、認可、暗号、状態遷移、契約テスト
- `docs/`: OpenAPI、セキュリティ設計、業務仕様

## セキュリティ境界

- 平文のapproval token、refresh token、access token、メール本文をログやevent inboxへ保存しません。
- BU共有メールのPIIはcurrent claimantだけが取得できます。
- 外部副作用はoperation ledgerまたはtransactional outboxを経由します。
- 未解決dead letterはretentionで自動削除しません。
- Gmail/Calendar adapterはSecret Managerのrefresh tokenから短期access tokenを取得します。
