# 現行実装ベースライン

更新日: 2026-07-21  
対象: `OpenclawSecretary-Back` 0.1.0

## 目的

この文書は、要件・将来設計ではなく、現在のリポジトリに実装されている動作を示す。仕様書に記載があっても、この文書の「未実装・部分実装」に記載された機能は現時点の実装完了範囲に含めない。

## 正本と優先順位

| 対象 | 正本 | 補足 |
|---|---|---|
| API method、path、request/response | `docs/api/openapi.yaml` | `npm run check:routes`でExpress登録と照合する |
| DB schema、制約、index | `migrations/*.sql` | DB設計書よりmigrationを優先する |
| 実行時動作 | `src/` | この文書はコードの要約であり、コード変更時に同時更新する |
| 要件・将来設計 | `docs/specs/gmail-ai-secretary/` | 現行実装を超える要件を含む |
| IAM、Cloud Run、Cloud SQL構築 | Terraform repository | このリポジトリでは前提だけを記載する |

## 実装概要

- Node.js 22以降、Express 5、PostgreSQL 15を使用する。
- OpenAPIは47 paths、49 operationsで、49操作すべてにExpress handlerが登録されている。
- 認証方式はGoogle user ID tokenと、Gateway、Bootstrap、Scheduler、Tasks、Admin、Runtimeのservice account OIDCを分離している。
- IAP検証とprivate Back呼出しを担当するGateway、pre-login redeemだけを公開するAuth Bootstrapを独立processとして実装している。
- 本番DB接続はCloud SQL Connectorのautomatic IAM authenticationを使用し、password接続文字列を受理しない。
- PIIとtoken payloadはCloud KMSをKEKとするAES-256-GCM封筒暗号で保存する。
- Google OAuth client secretとユーザーrefresh tokenはSecret Managerへ保存し、DBにはsecret resource名だけを保存する。
- Gmail、Calendar、Cloud Tasksなどの外部副作用はoperation ledgerまたはtransactional outboxを経由する。

## ディレクトリと責務

| パス | 責務 |
|---|---|
| `src/api-server.js` | HTTP route、認証方式の割当、HTTP response、相関ID |
| `src/gateway-server.js` | IAP検証、browser OAuth経路、private Backへのservice OIDC proxy |
| `src/auth-bootstrap-server.js` | Electron main向け単回handoff redeemの限定公開境界 |
| `src/auth/` | Google token検証、active user・membership・BUのresource認可 |
| `src/middleware/validate-request.js` | Ajvによる主要request body/query検証 |
| `src/services/` | transaction、状態遷移、監査、retention |
| `src/providers/google-oauth-provider.js` | OAuth code交換、token更新、Secret Manager操作 |
| `src/providers/google-workspace-provider.js` | Gmail送信・照合・Push/polling・watch更新、Calendar冪等作成 |
| `src/ai/gemini-analyzer.js` | DLP匿名化、Gemini段階ルーティング、JSON出力検証、日次利用上限 |
| `src/crypto/` | KMS封筒暗号 |
| `src/db-connection.js` | local `DATABASE_URL`と本番Cloud SQL Connector IAM接続の切替 |
| `tools/migrate.mjs` | advisory lock、checksum付きmigration適用 |
| `tools/check-route-coverage.mjs` | OpenAPIとExpress routeの双方向照合 |

## API実装範囲

以下のendpoint群が登録済みである。詳細なschemaとstatus codeはOpenAPIを参照する。

- Anonymous liveness probe・認証済みhealth
- Event inbox一覧・recipient単位ACK
- OAuth refresh、subject bind、self registration
- Gateway向け内部OAuth session、exchange、redeem
- Mail pending/tickets/detail、claim/release/transfer、認可済みtransfer target、approve/reject/token再発行
- Calendar proposal取得、承認、拒否、再提案、cancel、token再発行、operation status
- FAQ candidate取得、candidate承認、直接FAQ登録
- Settings取得・ETag付き全置換
- Admin user/BU登録、BU無効化
- Outbox dispatch、dead-letter replay
- Gmail send reconcile、OAuth compensate、Gmail Push通知、Gmail poll/watch更新、Calendar execute、PII retention

## 認証・認可

### User API

Google ID tokenについて、署名、期限、audience、hosted domain、email verificationを検証する。DBの`users.provisioning_status`が`active`であることも必須とする。

### Service API

Cloud Run audienceとservice account emailを検証し、次のschemeを相互に流用しない。

- `gateway`
- `bootstrap`
- `scheduler`
- `tasks`
- `admin`
- `runtime`

### Resource認可

BU resourceでは次を同時に要求する。

- `business_units.disabled_at IS NULL`
- membershipが有効期間内
- userが`active`

BU無効化transactionは現在のclaimとapproval tokenを失効させ、active membershipを終了する。Mail detailのPIIはpersonal ownerまたはcurrent claimantだけが取得できる。

## OAuthフロー

1. GatewayがIAP assertionを検証し、private APIへOAuth session作成を要求する。
2. numeric loopback host、port 1024-65535、`/callback/{43文字の乱数}`だけを通常のreturn URIとして許可する。既存session互換のため固定`/callback`もDB制約上は許可する。
3. PKCE verifierとnonceをKMSで暗号化して`oauth_sessions`へ保存する。
4. Google code交換後、refresh tokenをSecret Managerへ保存する。
5. userを`oauth_provisioning`から`active`へ遷移させる。
6. ID tokenをKMS暗号化handoff payloadへ格納し、Gatewayはopaque handoff codeと固定Auth Bootstrap URLだけをloopbackへ送る。
7. Electron mainがAuth Bootstrapへhandoff codeとverifierを送り、Bootstrap service identityと一致した単回redeemだけがhandoff payloadを取得できる。
8. 期限切れ・消費済みsessionはcompensate/retentionで物理削除する。

同一stateのexchangeは`exchange_started_at IS NULL`条件で一度だけ開始できる。

現行providerはID tokenにnonce claimが存在する場合の不一致を拒否するが、nonce claim自体の欠落は拒否していない。正本が要求するfail-closedなnonce bindとnegative testは`CR-AUTH-001`の未完了項目である。

### HUD向けclaim情報

ticket responseにはcaller-relativeな`claimState`を含む。一方、現行のticket/detail/event payloadには`claimerAttendeeRef`も残っているため、rendererへraw caller IDを渡さない目標境界は未完了である。転送commandに必要なtarget IDを除き、caller-relative DTOへ移行する必要がある。

## Gmailフロー

### PushとフォールバックPolling

Gmail `users.watch`がPub/Subへ通知し、認証済み`POST /internal/gmail/notifications`が通知先メールアドレスをSHA-256 mailbox refへ変換して対象mailboxだけを増分取得する。`POST /internal/gmail/watch/renew`はwatch期限を日次更新する。Pub/Sub通知の欠落・遅延に備え、`/internal/poll-gmail`は1時間周期のフォールバックとして維持する。

`mailbox_poll_state`をleaseし、History APIまたは初回messages listを取得する。取り込んだmessageは`(mailbox_ref,gmail_id)`で重複排除する。未知のPush通知先はPIIをログへ出さず無視する。

`AI_ANALYSIS_ENABLED=true`の場合はGoogle Cloud DLPで原文から氏名、メールアドレス、電話番号、所在地、組織名、生年月日、カード番号、IBANを匿名化してからVertex AIへ渡す。通常はGemini 2.5 Flash-Liteを使い、返信または日程調整が必要、もしくは低信頼の場合だけGemini 2.5 Flashへ昇格する。出力は固定JSON schemaで検証し、組織全体の日次request上限を`ai_usage_daily`でatomicに適用する。

分析成功時はcategory、urgency、summary、intent、actionsと暗号化reply draftを保存する。ただし現段階ではGmail draft作成とapproval token発行へ自動遷移せず、カードは`manual_action_required`のままとする。AI無効、上限到達、DLP/Vertex失敗、schema不正も同じ手動対応へフォールバックする。

### 承認送信

1. owner/current claimantとapproval token、subject hash、card version、期限を検証する。
2. `(mail_id,card_version)`で`mail_send_operations`を一意作成する。
3. Gmail draftへ`X-OpenClaw-Operation` markerを付け、thread IDを保存する。
4. draft sendを実行する。
5. response取得時は`succeeded`へ遷移する。
6. response不明時は`result_unknown`とし、直接再送しない。
7. reconcile workerがmarker/thread/message IDで照合し、`succeeded`、再試行、`failed_terminal`へ収束させる。

`reconciling`のlease期限切れも再取得対象である。

## Calendarフロー

- participantごとに`proposal_approvals`を保持する。
- 全員が同じslot IDを承認した場合だけ、暗号化execution planとoutbox eventを同一transactionで作成する。
- 選択slotが分かれた場合は`manual_review_required`へ遷移する。
- 拒否時はrejection detailをマスクし、最大3 revisionまで代替proposalを作成する。
- workerはparticipant credentialごとにprimary calendarへeventを冪等作成する。
- operation IDをCalendar private extended propertyへ保存し、再実行時に既存eventを検索する。
- 全成功は`executed`、部分失敗は`executed_with_failures`、全失敗は`manual_review_required`とする。
- `running`のlease期限切れは再取得し、participant単位のupsertを再開する。

## Outbox

許可するevent typeと配送先は`CloudTasksEnqueuer`の固定mapで管理する。

| event type | 配送先 |
|---|---|
| `calendar_operation_execute` | Calendar operation execute |
| `gmail_poll` | Gmail polling |
| `mail_send_reconcile` | Gmail send reconcile |
| `oauth_compensate` | OAuth compensation |

未知typeと不正payloadは即時dead letterとする。dead letter作成時は`operational_alerts`とPIIを含まない構造化critical logを作成する。管理者replayはstatusを`pending`へ戻し、実行者と解決理由を記録する。期限切れ`leased` eventは再取得する。

## DB実装

`001_initial.sql`から`004_cost_optimized_pilot.sql`までを順に適用する。テーブル数は25である。

| 分類 | テーブル |
|---|---|
| Identity/authorization | `users`, `business_units`, `business_unit_memberships`, `user_roles`, `user_invitations` |
| OAuth/credential | `oauth_sessions`, `provider_credentials` |
| Mail/AI | `emails`, `mailbox_poll_state`, `mail_send_operations`, `sent_reply_embeddings`, `ai_usage_daily` |
| Calendar | `calendar_proposals`, `proposal_approvals`, `calendar_operations`, `calendar_operation_results` |
| Event/audit | `timeline_events`, `event_inbox`, `event_inbox_recipients`, `error_acknowledgements`, `operational_alerts` |
| Outbox | `outbox_events` |
| FAQ | `faq_candidates`, `faq_entries` |
| Settings | `settings_revisions` |

`002_remediation.sql`はpgvector extension、embedding列、PII envelope列、poll checkpoint、dead-letter解決情報を追加する。
`003_loopback_callback_path.sql`はloopback return URI制約を高entropy callback pathへ拡張する。
`004_cost_optimized_pilot.sql`はGmail watch期限とAIの日次request/token利用量を追加する。

## Retention

1回500件を上限とし、`FOR UPDATE SKIP LOCKED`で処理する。

- ACK済みevent inbox: 全recipient ACKから7日後、またはhard expiryで削除
- FAQ candidate: pending期限切れ、accepted/expiredから90日で削除
- rejection detail: 90日でクリア
- 解決済みmail: 90日で件名・sender・body preview・summary・intent・actions・draft/tokenをマスクし、reply embeddingを削除
- OAuth session: consumed/expiredから1日で物理削除
- dispatched outbox: 30日で削除
- dead letter: `resolved_at`があるものだけ180日後に削除。未解決は削除しない

## Migration・デプロイ

- migration全体をsession advisory lockで直列化する。
- 適用済みmigrationのSHA-256 checksumを検証し、改変を拒否する。
- Dockerfileは`runtime`、`gateway`、`auth-bootstrap`、`migrate` targetを持つ。
- CIは`npm ci`、全check、4つのDocker targetのbuildを実行する。
- migration identityとruntime identityはTerraformとDB role bootstrap SQLで分離する。

## 自動検証

2026-07-21時点:

- `npm run check`: 成功
- Node test: 46件成功
- OpenAPI: 47 paths、49 operations、参照正常
- Route coverage: 49/49
- 独立一時ディレクトリでの`npm ci`と全check: 成功
- `npm audit`: 既知脆弱性0件

## 未実装・部分実装

次は要件・設計に存在するが、現行コードでは未完了または外部確認前である。

| 項目 | 状態 |
|---|---|
| AI分析から承認可能Gmail draftへの接続 | DLP匿名化、Gemini分析、暗号化reply draft保存までは実装済み。Gmail draft作成、approval token発行、`pending_reply_approval`遷移は未接続で、現状はmanual action cardとなる |
| FAQ/RAG embedding生成・検索 | schemaのみ。生成jobと検索Serviceは未実装 |
| Calendar freeBusyによる候補生成・実行直前再検証 | 未実装。既定adapterは保存済みslotの冪等event作成まで |
| Domain-wide Delegation | 未実装。既定adapterはparticipant/owner/claimerのOAuth credentialを使用する |
| Calendar用OAuth scope | 現在の同意scopeは`openid email gmail.modify`のみ。Calendar APIを実環境で使用するにはCalendar scope追加、既存利用者の再同意、scope検証が必要 |
| OpenAPI全request/responseの実行時自動検証 | 主要requestはAjv検証済み。全response schema検証は未実装 |
| API rate limiting | OpenAPIに429定義はあるがアプリケーション実装は未完了 |
| OAuth nonce fail-closed | nonce不一致は拒否するが、ID tokenのnonce claim欠落を許容する。欠落・不一致のprovider testが必要 |
| HUD claim情報最小化 | `claimState`は実装済みだがticket/detail/eventにraw `claimerAttendeeRef`が残る |
| Front main session commit | request abortとrenderer PII消去は実装済み。login/refresh完了とconfig/logoutの競合を防ぐmain process session epochは未実装 |
| Cloud Monitoring alert policy | 5xx、auth-bootstrap deny、Cloud SQL CPU、Calendar queue、background failureは定義済み。availability/latency alertとstaging発火確認は未実施 |
| Production Cloud Run minimum instance | API/Gateway/Auth Bootstrapは1以上をTerraform guardで強制済み。revision切替と可用性はstaging未確認 |
| PostgreSQL + pgvectorへの実migration試験 | ローカルDB未起動のため未実施 |
| Docker image build | Docker daemon未起動のためローカル未実施。CI定義は追加済み |
| Container release provenance | Terraformは署名を検証するが、Backにbuild/push/SBOM/provenance/cosign署名を生成するrelease workflowがない |
| Google実アカウントE2E | Secret Manager、Gmail、Calendarを使うstaging試験が必要 |
| Auth Bootstrap・IAP E2E | ローカルの認証境界testは成功。実Cloud Run/IAPでstart/callback/redeemを通す必要がある |
| Cloud SQL IAM DB認証 | Connector unit testとTerraform validateは成功。実Cloud SQLでmigration/runtimeの権限分離を確認する必要がある |

## 文書更新ルール

- route追加・削除時はOpenAPIとhandlerを同一変更に含める。
- schema変更時は新しいmigration、DB文書、この文書を同一変更に含める。
- 状態遷移変更時はService、OpenAPI enum、process flow、test planを同時更新する。
- 実装済みと記載するには、自動テストまたはstaging検証結果を併記する。
