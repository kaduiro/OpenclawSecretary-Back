# Backend Tasks: Gmail AI Secretary

作成日: 2026-06-25  
更新日: 2026-07-21  
ステータス: IMPLEMENTATION IN PROGRESS

この一覧は、要件上の作業ではなく現在のrepositoryの実装状況を追跡する。詳細な現在値は[現行実装ベースライン](../../implementation/current-implementation.md)、受入れ結果は[検証報告](validation_report.md)を参照する。

## 完了

- [x] OpenAPIを47 path/49 operationへ更新し、49 operationすべてをExpress handlerへ登録する。
- [x] Google ID tokenとGateway/Scheduler/Tasks/Admin service accountの認証schemeを分離する。
- [x] active user、owner、BU membership、current claimant、proposal participantに基づくresource認可を実装する。
- [x] OAuth state/PKCE/return URI/handoff challenge、単回redeem、Secret Manager保存、provisioning補償を実装する。
- [x] PostgreSQL migrationを4本に分け、認可、回復、provider credential、運用alert、Gmail watch、AI usage上限を含むschemaを定義する。
- [x] Gmail pollingのlease、History/list取得、checkpoint、`(mailbox_ref,gmail_id)`重複排除、暗号化preview保存を実装する。
- [x] Gmail Pub/Sub通知、mailbox限定増分取得、日次watch更新、1時間フォールバックpollingを実装する。
- [x] DLP匿名化、Flash-Lite優先/Flash条件昇格、固定JSON schema、日次request上限、暗号化reply draft保存を実装する。
- [x] Gmail送信台帳、transactional Outbox、冪等send、result unknown reconcile、dead-letter replayを実装する。
- [x] mail claim/transfer/force claim、approve/reject、FAQ candidate acceptの状態遷移を実装する。
- [x] Calendar proposalの取得、claim、approve/reject、cancel、alternative revision、selection conflictを実装する。
- [x] Calendar operation生成、暗号化plan、Outbox dispatch、保存済みslotの冪等event作成と結果記録を実装する。
- [x] Outbox event typeのallowlist、lease/backoff/dead-letter、運用alertとacknowledgementを実装する。
- [x] event inbox、FAQ candidate、OAuth session、draft/plan/provider IDを対象にretention jobを実装する。
- [x] Ajvによる主要command body検証、migration runner、OpenAPI/route coverage検査、CI workflow、Dockerfileを追加する。

## 部分実装

- [ ] OAuth ID tokenのnonce claim欠落・不一致をproviderでfail-closedにし、negative testを追加する。
- [ ] ticket/detail/eventからraw `claimerAttendeeRef`を除き、caller-relative DTOへ統一する。
- [ ] Front main processへsession epochを導入し、login/refresh commit競合とCalendar approval token消去をtestする。
- [ ] 保存済みAI reply draftからGmail draftを作成し、approval token発行と`pending_reply_approval`遷移へ接続する。接続完了までは安全側に`manual_action_required`を生成する。
- [ ] FAQ/RAG embedding生成、検索、version付きoutput schema、prompt injection/poisoning防御を実装する。DB schemaのみ存在する。
- [ ] Calendar freeBusy planner、SchedulingPolicy、決定的slot rank、実行直前のfree/busy/ETag/revision再検証を実装する。
- [ ] Domain-wide Delegationとsubject allowlistをproviderへ実装する。現在のGoogle API経路は個人OAuth credentialを使う。
- [ ] OpenAPI全request/responseを共通middlewareで検証する。現在は主要command requestのみAjv検証する。
- [ ] API rate limitingと429応答を実装する。
- [ ] structured logを全flowへ統一し、availability/latencyを含むCloud Monitoring alert policyをTerraform側で設定する。
- [x] auth-bootstrapのproduction minimum instanceを1以上にし、Terraform guard testを追加する。
- [ ] Backの4 container targetをpushし、SBOM/provenance/cosign署名を発行するrelease workflowを追加する。
- [ ] migrationからER図とカラム辞書を生成し、旧snapshotを置き換える。

## Calendar有効化前の必須対応

- [ ] OAuth scopeをGoogle公式の現行scopeと照合し、Calendar events/freeBusyに必要な最小scopeを決定する。
- [ ] `src/providers/google-oauth-provider.js`の同意scopeへCalendar scopeを追加し、返却scopeの不足をfail closedにする。
- [ ] 既存refresh token利用者の再同意手順とcredential migration手順を定義する。
- [ ] security、requirements、Terraform OAuth設定のscope表記を同じ値へ統一する。

## リリースゲート

- [x] `npm run check`: 46 test、OpenAPI 49 operation、route coverage 49/49。
- [ ] PostgreSQL 15 + pgvectorへ`001`から`004`を順次適用し、rollback/再実行/制約を検証する。
- [ ] Docker imageをbuildし、non-root起動、health/readiness、環境変数不足時のfail closedを検証する。
- [ ] Google OAuth、Secret Manager、KMS、Gmailを接続したstaging E2Eを実施する。
- [ ] Calendar scope対応後、Calendar APIを接続したstaging E2Eを実施する。
- [ ] Cloud Tasks dispatch、retry、dead-letter、replayの実環境crash-point試験を実施する。
- [ ] Gateway/Admin/Scheduler/Tasks service accountのaudience、email、endpoint allowlistをTerraformとcontract reviewする。
- [ ] PIIがDB、Cloud Logging、event inbox、alert payloadに平文保存されないことを実環境で確認する。

## 文書運用

- 完了へ移す際はtest名またはstaging evidenceを[検証報告](validation_report.md)へ追加する。
- API変更は`docs/api/openapi.yaml`、DB変更は新規migrationを先に更新する。
- 実装と目標設計の差が残る場合、設計書側で「実装済み」と表現しない。
