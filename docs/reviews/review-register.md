# 3 Repository Review Register

更新日: 2026-07-20  
対象: `OpenclawSecretary-Back` / `OpenclawSecretary-Front` / `OpenclawSecretary-Terraform`

この文書を3リポジトリ横断レビューの基準とする。レビューのたびに別の指摘一覧を作らず、既存IDの状態と証跡を更新する。BackのAPI、application security、現行実装に関する記述はBackの正本を優先する。

## Review Rules

1. IDは再採番、再利用、削除しない。解消後も`RESOLVED`として残す。
2. 新規指摘はfile、契約、test、実環境結果のいずれかの証拠を必須とする。
3. 未実装、確認未実施、設計判断待ち、文書矛盾を区別する。確認できていないだけの項目を実装不良と断定しない。
4. 状態は`OPEN`、`VERIFY_REQUIRED`、`BLOCKED_DECISION`、`RESOLVED`、`ACCEPTED_RISK`だけを使用する。
5. `RESOLVED`への変更には対策コードと自動検証またはstaging証跡を必要とする。文書だけの更新では実装問題を解消扱いにしない。
6. severityは影響が変わった証拠がある場合だけ変更し、変更理由を履歴へ記録する。
7. 各レビュー結果は「新規」「状態変更」「継続」「解消」の順で報告する。該当がなければ`なし`と明記する。
8. 過去の`history/review_cycle.md`は意思決定履歴であり、現行OPEN一覧には使用しない。
9. 毎回のレビュー対象は3リポジトリ共通で、`契約`、`認証・認可`、`データ整合性・PII`、`可用性・運用`、`供給網・CI`、`テスト・文書`の6観点に固定する。新しい証拠は最初に既存IDへ対応付け、原因が独立する場合だけ新規IDを作る。

## Severity

| Level | Meaning |
|---|---|
| P0 | production release、認証境界、data lossまたは主要経路をblockする |
| P1 | 主要機能またはsecurity controlが未充足 |
| P2 | contract hardening、運用品質、文書整合 |
| P3 | 将来改善。現行releaseをblockしない |

## Current Register

| ID | Severity | Classification | Status | Owner | Finding / Evidence | Countermeasure / Acceptance |
|---|---|---|---|---|---|---|
| CR-AUTH-001 | P0 | CONFIRMED_CONTRADICTION | OPEN | Back + Front + Terraform | bootstrap分離と単回redeemは実装済みだが、Back OAuth exchangeが`claims.nonce`欠落を許容しており、正本が要求するnonce bindをfail-closedにしていない。該当negative testもない | `claims.nonce === expectedNonce`を必須化し、nonce欠落・不一致を拒否するprovider testを追加した後、stagingでstart/callback/redeemとpublic境界を確認する |
| CR-GW-001 | P0 | MISSING_IMPLEMENTATION | RESOLVED | Back | IAP JWT検証、user Authorization転送、private Back向けSA OIDC生成を行うGateway serverとcontainer targetを実装し、認証有無とhandoffのtestが成功 | Gateway変更時はIAP assertion、service identity、Authorization非混同のtestを維持する |
| CR-CAL-001 | P1 | MISSING_IMPLEMENTATION | OPEN | Back | `src/providers/google-oauth-provider.js`のscopeが`openid email gmail.modify`のみ | Calendar scope、返却scopeのfail-closed検証、既存利用者の再同意を実装しstagingで確認する |
| CR-CAL-002 | P1 | MISSING_IMPLEMENTATION | OPEN | Back | Calendar freeBusy plannerと実行直前revalidationは`validation_report.md`で未実装 | provider fixture、競合、stale ETag、replanの自動testとstaging試験を通す |
| CR-DWD-001 | P1 | MISSING_IMPLEMENTATION | OPEN | Back + Terraform | Domain-wide Delegation経路は設計のみ | keyless `signJwt`最小権限、allowlist、対象外fail-closed、auditを実装・検証する |
| CR-AI-001 | P1 | MISSING_IMPLEMENTATION | VERIFY_REQUIRED | Back + Terraform | DLP匿名化、Flash-Lite優先/Flash昇格、固定JSON schema、DB日次上限、暗号化reply draft保存と失敗時manual action fallbackを実装しunit testは成功。Gmail draft/approval遷移への接続と実DLP/Vertex確認は未完了 | stagingでPII非送信、quota上限、schema不正、provider障害を確認し、Gmail draft作成とapproval token発行へ接続する |
| CR-RAG-001 | P1 | MISSING_IMPLEMENTATION | OPEN | Back | FAQ/pgvectorはschema中心で生成・検索serviceが未実装 | reviewed dataだけをindex化し、prompt injection/PII/poisoning testを通す |
| CR-API-001 | P1 | SECURITY_HARDENING | OPEN | Back | OpenAPIに429はあるがAPI rate limiterが未実装 | endpoint別制限、`Retry-After`、approval token試行制限を実装しtestする |
| CR-API-002 | P2 | CONTRACT_HARDENING | OPEN | Back | requestの主要部分はAjv検証済みだが全response schema検証は未実装 | OpenAPI response validatorまたはcontract fixtureを全operationへ適用する |
| CR-DB-001 | P0 | VERIFICATION_GATE | VERIFY_REQUIRED | Back + Terraform | migrationは静的testのみで実PostgreSQL/pgvectorへ未適用 | 空DB適用、再実行、checksum、constraint、retention queryを実DBで通す |
| CR-IMG-001 | P0 | VERIFICATION_GATE | VERIFY_REQUIRED | Back | runtime/migrate Docker targetはあるがlocal image build/runが未確認 | 両targetをbuildし、migrationとhealth/readinessをcontainerで確認する |
| CR-GCP-001 | P0 | VERIFICATION_GATE | VERIFY_REQUIRED | Back + Terraform | OAuth、Secret Manager、KMS、Gmail/Calendarはmock検証まで | staging projectで実Google account E2Eを実行しPIIを含まない証跡を保存する |
| CR-TASK-001 | P0 | VERIFICATION_GATE | VERIFY_REQUIRED | Back + Terraform | Cloud Tasks enqueueはmock、実dispatch/crash-point未確認 | OIDC audience/SA、重複、lost response、terminal/transient結果をstagingで確認する |
| CR-INF-001 | P0 | VERIFICATION_GATE | VERIFY_REQUIRED | Terraform | HCLのfmt/validateとBack静的契約はPASS。実projectのplan/apply、IAM、IAP、alert発火は未確認 | secretを含まないplan review、3段階bootstrap apply、negative IAM、alert試験を通す |
| CR-E2E-001 | P0 | VERIFICATION_GATE | VERIFY_REQUIRED | Front + Back + Terraform | Front test/buildと個別契約はPASSだが、実Gateway/Backを使う業務flowは未実施 | login、ticket claim、approve/reject、Calendar、FAQ、token refreshをstagingで通す |
| CR-DOC-001 | P1 | DOCUMENTATION_CONFLICT | RESOLVED | Front + Terraform | 旧Front仕様とTerraform runbook/security/specsを`docs/legacy`へ隔離し、現行docsをBack v2.0.0正本へ限定した。旧version/env名の再流入を拒否するdocs checkも追加 | Back契約変更時はlockと現行docsを同じ変更で更新し、legacyは現行判断に使用しない |
| CR-INF-002 | P0 | CONFIRMED_CONTRADICTION | VERIFY_REQUIRED | Terraform | Backにanonymous `/livez`を追加し、全Cloud Run livenessを同pathへ変更した。route test、Terraform validate、Back契約checkは成功 | 実Cloud Run revisionが起動を維持し、認証済み`/v1/health`とanonymous `/livez`が期待どおり応答することを確認する |
| CR-INF-DB-001 | P0 | CONFIRMED_CONTRADICTION | VERIFY_REQUIRED | Back + Terraform | Cloud SQL Connector automatic IAM auth、runtime/migration用IAM DB user、DB role分離SQLを実装し、本番`DATABASE_URL`を禁止した。unit testとTerraform validateは成功 | 実Cloud SQLへmigration identityとruntime identityの両方で接続し、runtimeがDDLできないnegative testを通す |
| CR-FRONT-SEC-001 | P1 | SECURITY_HARDENING | RESOLVED | Front | navigationをparsed origin完全一致へ変更し、CSP、permission deny、固定production URLを実装。悪性URLのnegative testとbuildが成功 | Electron security設定変更時はnavigationとpermissionのnegative testを維持する |
| CR-FRONT-AUTH-001 | P1 | SECURITY_HARDENING | RESOLVED | Front | 高entropy callback path、8KiB上限、有効requestまでの待機、Abort/cleanupに加え、callbackのredeem URLを管理済みAuth Bootstrap URLへ完全一致させた。任意origin拒否を含むnegative testが成功 | loopback listener変更時はURL authority固定を含む既存の異常系testを維持する |
| CR-FRONT-NET-001 | P1 | RELIABILITY_GAP | RESOLVED | Front | GET/副作用別timeout、session AbortSignal、single-flight polling、logout/config変更時cancel、認証世代が異なる非同期結果の破棄を実装。request abortとPOST非retry testが成功 | operation polling変更時は同時実行数、世代分離、副作用非retryを検証する |
| CR-FRONT-CONTRACT-001 | P1 | CONTRACT_HARDENING | RESOLVED | Front | Back v2.0.0 OpenAPIのSHA-256、必須26 operation、`claimState`をlockし、主要response validatorをIPC前に適用した。異常fixtureと実Back digest照合が成功 | Back契約変更時はOpenAPI、lock、validator、fixtureを同一変更に含める |
| CR-FRONT-BOOT-001 | P1 | MISSING_IMPLEMENTATION | VERIFY_REQUIRED | Front | `signed_out`/`provisioning`/`ready`/`reauth_required`を実装し、ready以外の業務取得・操作を停止した。型検査とbuildは成功 | component/E2E testでprovisioning中の業務API未呼出しとreauth復帰を確認する |
| CR-FRONT-SESSION-001 | P1 | SECURITY_HARDENING | OPEN | Front | rendererのlogout後PII消去は実装済みだが、main processのlogin/refresh完了にはsession epoch確認がなく、設定変更直後に旧非同期結果がtoken storeを再設定できる競合が残る。Calendar approval tokenも成功後にMapから削除されない | main processでsession epochを採番してlogin/refresh commit前に一致確認し、resetと競合するtestを追加する。Calendar approve/reject成功時は対応tokenを削除する |
| CR-FRONT-CLAIM-001 | P1 | CONTRACT_GAP | OPEN | Front + Back | caller-relative `claimState`は実装済みだが、ticket/detail/event responseがraw `claimerAttendeeRef`をrendererへ返しており、対策計画の「raw caller IDを渡さない」と矛盾する | ticket/detail/eventを`claimState`・`claimHeldByCaller`等のcaller-relative DTOへ変更し、転送commandに必要なtarget ID以外をrendererへ出さないcontract/negative testを追加する |
| CR-FRONT-OPS-001 | P1 | MISSING_IMPLEMENTATION | VERIFY_REQUIRED | Front | mail/calendar operation polling、calendar cancel、critical error ackをIPC/UIへ接続し、GETだけをpollingする実装を追加。buildは成功 | 200/202/result_unknown/cancel/error-ackのcomponent/E2E workflow testを通す |
| CR-FRONT-DIST-001 | P1 | RELEASE_GAP | VERIFY_REQUIRED | Front | electron-builderとSHA pin済みWindows配布workflowを追加し、unpacked artifact生成は成功。ローカル生成exeは`NotSigned` | 署名証明書をCI secretへ登録し、Authenticode有効なinstallerのclean install/smoke testとprovenance確認を通す |
| CR-INF-ALERT-001 | P1 | OPERATIONS_GAP | VERIFY_REQUIRED | Terraform | prodでnotification channel 1件以上を要求するpreconditionを追加し、Terraform validateは成功 | stagingでalert発火・通知・復旧を確認し、prod channel IDを管理値として確定する |
| CR-INF-STATE-001 | P1 | OPERATIONS_GAP | VERIFY_REQUIRED | Terraform | versioning、uniform access、public access prevention、最小IAM、prevent_destroyを持つ独立bootstrap stackと手順を追加しvalidate成功 | 実bucket作成、既存state migration、環境別prefix、CI同時実行時lockを確認する |
| CR-INF-IAP-001 | P0 | SECURITY_HARDENING | VERIFY_REQUIRED | Terraform | IAP programmatic clientをproject-level settingsへ登録し、access member validationでpublic principalを拒否した。Terraform validate/testと静的契約checkは成功 | stagingで登録clientのtoken受理、未登録client/public principalの拒否、Gateway以外の非公開を確認する |
| CR-INF-HA-001 | P1 | OPERATIONS_GAP | VERIFY_REQUIRED | Terraform | Cloud SQL REGIONAL、API/Gateway/Auth Bootstrap minimum instance、deletion protection、backup guardを実装し、productionのAuth Bootstrap min=0を拒否するtestを追加した | stagingでfailover、PITR/restore、削除拒否、revision切替と各serviceのminimum instanceを確認する |
| CR-INF-OBS-001 | P1 | OPERATIONS_GAP | OPEN | Terraform | 5xx、auth-bootstrap deny、Cloud SQL CPU、Calendar queue、background failureのalertはあるが、現行architectureが必須とするavailability/latency alertがHCLに存在しない | Gateway/APIのuptimeまたはabsenceとrequest latency SLO alertを追加し、全conditionの発火・通知・復旧をstagingで確認する |
| CR-INF-SUPPLY-001 | P2 | SUPPLY_CHAIN | OPEN | Back + Terraform | Terraform plan前のcosign verifyと4 image scanは定義済みだが、Back CIはlocal Docker buildだけでArtifact Registry push、SBOM/provenance、cosign署名を生成するproducer workflowがない | Backで4 targetをbuild/pushし、digest、SBOM/provenance、keyless signatureを発行するtrusted release workflowを追加し、Terraform consumerとの成功・拒否testを通す |
| CR-CI-001 | P2 | VERIFICATION_GAP | VERIFY_REQUIRED | Front + Terraform | Front check/契約/監査/署名packageとTerraform fmt/validate/contract/tflint/Trivy/WIF plan workflowを追加し、Actionsをcommit SHA pinした | GitHub上でPR workflowとtrusted environment planを実行し、required checkとartifact保持を確認する |
| CR-BE-BASE-001 | P0 | IMPLEMENTATION_BASELINE | RESOLVED | Back | 2026-07-21時点で46 test、OpenAPI 47 path/49 operation、route coverage 49/49、audit 0件 | Backのroute/API baselineを変更するPRで同じcheckを維持する |
| CR-FRONT-BASE-001 | P0 | IMPLEMENTATION_BASELINE | RESOLVED | Front | Electron HUD、main process token境界、Back v2 client、visibility-aware pollingを実装。node 16件とcomponent/state 5件、build、固定digest/必須26 operation照合が成功 | `npm run check`とtoken非露出・session消去・polling policy testを維持する |
| CR-INF-BASE-001 | P0 | IMPLEMENTATION_BASELINE | RESOLVED | Terraform | Cloud Run/IAP/IAM/SQL/KMS/Secrets/Scheduler/Tasks/PubSub/migration/monitoring/budget HCLとpilot guardを実装。Terraform 1.13.5/provider 7.40.0でvalidate、production/Pilot guard 8 test、Back静的契約18 env/6 jobs/Push route照合が成功 | `fmt -check`、`validate`、`test`、Back契約checkを維持する |

## Review Output Template

今後のレビュー回答は必ず次の順序にする。

1. **新規**: 新しいID、証拠、既存項目に含められない理由
2. **状態変更**: ID、旧状態、新状態、根拠
3. **継続**: 状態が変わらないIDと追加証拠だけ
4. **解消**: `RESOLVED`にしたIDとacceptance証跡
5. **総合判定**: `BLOCKED` / `CONDITIONAL_PASS` / `PASS`

表現や観点が増えただけで既存項目と同じ原因なら、新規IDを作らず既存IDへ証拠を追加する。

## Change History

| Date | Change |
|---|---|
| 2026-07-16 | 初版。Back validation reportの未実装・未検証項目と、3 repository契約監査結果を固定IDへ統合 |
| 2026-07-16 | Front/Terraform実装レビューを追加。runtime probe/DB接続のP0矛盾、Front security・workflow・distribution、Terraform alert/state、横断CIを新規ID化 |
| 2026-07-20 | Gateway/bootstrap、IAM DB認証、Front防御・workflow・配布、Terraform alert/state/CIを実装。ローカル自動検証済みとstaging/署名/CI未検証を分離して状態更新 |
| 2026-07-20 | Front session分離・callback authority固定・Back契約digest lock、Terraform IAP programmatic client・production HA/observability/supply-chain guard、現行docs gateを追加。実環境gateは`VERIFY_REQUIRED`を維持 |
| 2026-07-20 | 共通6観点を固定。OAuth nonce欠落許容、raw claimer ID、main session競合、auth-bootstrap scale-to-zero、availability/latency alert欠落、container署名producer欠落を既存IDへ統合し、該当6件を`OPEN`へ更新 |
| 2026-07-20 | Back/Front/TerraformのREADME、現行実装、security、validation、test/task、contract、architecture文書を上記6件の`OPEN`状態とproduction `BLOCKED`判定へ同期 |
