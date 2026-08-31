---
status: BLOCKED
---

# Gmail AI Secretary Backend Validation Report

作成日: 2026-06-07  
更新日: 2026-07-21  
対象: repository内の認証・認可・副作用回復・privacy・OpenAPI整合性

## 判定

**BLOCKED: ローカル実装ベースラインは成立しているが、P0認証条件とproduction release gateが未充足。**

3リポジトリ横断の未解決事項と状態は`docs/reviews/review-register.md`を唯一の現行台帳とする。本書の項目をレビューごとに別採番しない。

OpenAPI、全route登録、主要domain service、4本のmigration、Gmail/Calendar adapter、Outbox、retentionのrepository内検証は通過した。ただし、OAuth nonce欠落拒否、実PostgreSQL、Docker、Google provider、Cloud Tasksを接続した検証は未実施であり、本番リリース承認には使用できない。

さらに、現在のOAuth同意scopeは`openid email gmail.modify`でCalendar scopeを含まない。Calendar providerのstaging試験前にscope追加と既存利用者の再同意が必要である。

## 自動検証結果

2026-07-21に`npm run check`を実行し、すべて成功した。

| 検査 | 結果 | 証跡 |
|---|---|---|
| Node.js test | PASS、46 test | `node --test` |
| OpenAPI parse/local ref/operationId | PASS、47 path/49 operation | `tools/validate-openapi.mjs` |
| Route coverage | PASS、49/49 | `tools/check-route-coverage.mjs` |
| Migration structural invariants | PASS、静的検査 | `test/migration.test.js` |
| API composition/validation | PASS | `test/api-server.test.js` |
| OAuth session storage/handoff | PASS。ただしproviderのnonce claim欠落拒否は未検証 | `test/oauth-session.test.js` |
| Resource authorization | PASS | `test/resource-authorizer.test.js` |
| Gmail reconcile | PASS | `test/mail-reconcile.test.js` |
| Google credential resolution | PASS、mock | `test/google-workspace-provider.test.js` |
| Gmail Push/watch更新 | PASS、mock | `test/gmail-push.test.js` |
| DLP後Gemini routing・日次上限 | PASS、mock | `test/gemini-analyzer.test.js` |
| Outbox target allowlist | PASS | `test/cloud-tasks-enqueuer.test.js` |
| Encryption envelope | PASS | `test/envelope.test.js` |
| Retention invariant | PASS | `test/retention.test.js` |

## 実装確認済み

- User/Service authentication schemeの分離とproduction設定不足時のfail closed。
- active user、owner、BU membership、claimant、proposal participantのresource境界。
- OAuth sessionのstate/PKCE/return URI/handoff bind、expiry、単回消費。nonceは生成・保存・providerへ送信済みだが、ID tokenのclaim欠落拒否は未完了。
- refresh tokenのSecret Manager保管とDBへのresource名保存。
- Gmail operation ledger、Outbox、reconcileによる不確定結果の回復。
- Gmail Pub/Sub通知、mailbox限定増分取得、watch期限更新、1時間フォールバックpolling。
- DLP匿名化後のFlash-Lite優先/Flash条件昇格、固定JSON schema、日次request上限、暗号化reply draft保存。承認可能Gmail draftへの接続は未完了。
- Calendar approval state machine、暗号化execution plan、冪等operation結果記録。
- event inbox、FAQ、OAuth session、draft/plan/provider IDの保持期限処理。
- correlation ID、構造化error、dead-letter replay、運用alert記録。

## 未検証・未実装

| 項目 | 状態 | リリースへの影響 |
|---|---|---|
| 実PostgreSQL/pgvector migration | 未検証 | schema適用のrelease gate |
| Docker image build/run | 未検証 | deployのrelease gate |
| Google OAuth/Secret Manager/KMS/Gmail E2E | 未検証 | Gmail機能のrelease gate |
| Calendar OAuth scope | 未実装 | Calendar機能のblocker |
| Calendar freeBusy planner/revalidation | 未実装 | 自動日程調整のblocker |
| Domain-wide Delegation | 未実装 | BU共有Google account経路のblocker |
| Cloud Tasks実接続/crash-point | 未検証 | 非同期副作用のrelease gate |
| AI分析/返信draft生成 | 未実装 | AI秘書機能のblocker |
| FAQ/RAG生成・検索 | 未実装 | RAG機能のblocker |
| 全response schema検証 | 未実装 | contract hardening残作業 |
| API rate limiting | 未実装 | internet-facing公開前のblocker |
| raw claimant ID除去 | 未実装 | renderer data-minimizationのblocker |
| Front main session epoch/token cleanup | 部分実装 | config/logout競合とCalendar approval token保持のblocker |
| Terraform auth-bootstrap minimum instance | 未実装 | production login可用性のblocker |
| Terraform availability/latency alert | 未実装 | production運用のrelease gate |
| Container build/push/sign producer | 未実装 | Terraform cosign consumerを成立させるrelease gate |
| Terraform IAM/alert実環境contract | 未検証 | production運用のrelease gate |

## 正本と参照先

| 対象 | 正本 |
|---|---|
| API | `docs/api/openapi.yaml` |
| DB | `migrations/*.sql` |
| 現行実装範囲 | `docs/implementation/current-implementation.md` |
| 目標要件・設計 | `docs/specs/gmail-ai-secretary/` |
| 実装残作業 | `docs/specs/gmail-ai-secretary/tasks.md` |

## 承認条件

1. OAuth nonce欠落拒否、raw claimant ID除去、Front main session epoch/token cleanupを実装しnegative testを通す。
2. Terraformのauth-bootstrap minimum instance、availability/latency alertを実装し、Backのcontainer release producerから署名済みdigestを発行する。
3. 実PostgreSQLへmigrationを適用し、再実行、制約、retention queryを検証する。
4. Calendar scopeを実装し、再同意と不足scope拒否を検証する。
5. Google providerとCloud Tasksを接続したstaging E2E/crash-point試験を通す。
6. TerraformのIAM、secret access、KMS、alert policyをbackend設定と照合する。
7. AI/RAGを有効化する場合は非信頼入力、schema、PII、poisoning試験を追加する。

上記が完了するまで、artifactの状態は`BLOCKED`のままとし、`CONDITIONAL_PASS`または`APPROVED`へ変更しない。
