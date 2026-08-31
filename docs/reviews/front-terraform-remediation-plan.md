# Front / Terraform Remediation Plan

策定日: 2026-07-16  
更新日: 2026-07-20  
状態: PARTIALLY_IMPLEMENTED / LOCAL_REMEDIATION_REQUIRED / STAGING_VERIFICATION_PENDING  
対象: `OpenclawSecretary-Back` / `OpenclawSecretary-Front` / `OpenclawSecretary-Terraform`

## 1. 目的と基準

`review-register.md`のFront/Terraform関連指摘を、依存順序、変更対象、受入条件を持つ実装計画へ変換する。指摘IDと状態は`review-register.md`だけで管理し、この文書で再採番しない。

- BackのOpenAPI、application security、認証・認可契約を正本とする。
- 現行のBack正本文書同士に実装不能な矛盾がある場合は、最初のPRで意思決定を正本へ反映してから実装する。
- Backの変更は原則additiveにし、FrontとTerraformを別々にdeployできる互換期間を設ける。
- `terraform validate`やunit testの成功だけで本番可としない。実Cloud Run、Cloud SQL、IAPでのstaging証跡をrelease gateにする。

## 2. 採用する対応方式

### 2.1 OAuth bootstrap境界

現行の「Gateway全体をIAP保護」と「pre-login Electronがredeemをprogrammaticに呼ぶ」を同時には成立させられない。次を推奨方式とする。

1. `openclaw-hud-gateway`は引き続きIAP保護し、browserの`/v1/auth/start`と`/v1/auth/callback`、認証後API proxyを担当する。
2. `openclaw-auth-bootstrap`を別Cloud Run serviceとして追加し、公開するのは`POST /v1/auth/handoff/redeem`だけとする。
3. bootstrap serviceは60秒、単回利用、高entropyのhandoff codeとElectron mainだけが持つverifierを検証し、専用SAでprivate Backの`/internal/auth/handoff/redeem`だけを呼ぶ。
4. ID tokenはElectron mainへだけ返し、system browser、renderer、URL、logへ出さない。
5. body上限、endpoint別rate limit、no-store、request body非記録、CORS拒否、replay/expiry/verifier mismatch監査を必須にする。

Backには`BOOTSTRAP_SA_EMAIL`と専用caller schemeを追加し、このSAを`/internal/auth/handoff/redeem`以外のinternal endpointでは拒否する。Cloud Run `roles/run.invoker`だけでapplication-level authorizationを代替しない。

この方式を採用し、BackのC-07、BE-REQ-039、OpenAPIを限定公開bootstrap例外で更新した。bootstrap分離とローカル契約testは完了したが、Back providerがID tokenのnonce claim欠落をfail-closedにしていないため、`CR-AUTH-001`は`OPEN`とする。

### 2.2 Cloud SQL接続とDB権限

productionでは`@google-cloud/cloud-sql-connector`とautomatic IAM database authenticationを採用する。`DATABASE_URL`はlocal/test互換だけに限定する。

- runtime SAとmigration SAへ`roles/cloudsql.client`と`roles/cloudsql.instanceUser`を付与する。
- Terraformで両SAのCloud SQL IAM database userを作成する。
- Backへ`INSTANCE_CONNECTION_NAME`、`DB_NAME`、`DB_USER`を追加し、runtime/migrationで同じconnection factoryを使用する。
- DB roleは`openclaw_runtime`と`openclaw_migrator`へ分ける。runtimeは必要なDMLとsequenceだけ、migratorはschema変更だけを許可する。
- 初回のrole/grantだけは、承認済みoperatorがchecked-in bootstrap SQLをCloud SQL Connector経由で実行する。admin credentialをTerraform stateへ保存しない。
- productionで`DATABASE_URL`だけが設定された場合はfail closedにする。

### 2.3 Frontの契約と状態管理

- 認証状態を`signed_out`、`provisioning`、`ready`、`reauth_required`へ正規化し、`ready`以外では業務操作を禁止する。
- Gateway URLとAuth Bootstrap URLを管理設定として保存し、callbackが提示するredeem URLは管理値との完全一致だけを許可する。
- logout、設定変更、401ではsession AbortControllerを中止し、token、approval token、polling、rendererの全業務DTOを消去する。旧認証世代の非同期結果は破棄する。
- ticket responseへ`claimState: unclaimed | mine | other`をadditiveに追加する。rawなcaller IDや不要なPIIはrendererへ渡さない。
- 202 responseはoperation IDをrenderer用DTOへ変換し、GETだけを期限付きpollingする。副作用POSTを自動再送しない。
- response schema validationをmain process境界へ導入し、Back OpenAPIのversion、SHA-256、必須operationをlockする。

### 2.4 Terraform運用境界

- livenessは`/livez`、startupはTCPを使用する。認証・DB状態を含む`/v1/health`をplatform probeへ使わない。
- remote stateは独立したstate-bootstrap stackで作成する。本体stack自身にbackend bucketを作らせない。
- prodではnotification channelを1件以上必須にする。
- IAP programmatic clientをTerraform管理し、public principalを変数validationで拒否する。
- productionではCloud SQL REGIONAL、Cloud Run minimum instance、API deletion protectionを強制する。
- container imageは同一project Artifact Registryのdigestだけをproductionで受理し、plan前にcosignとTrivyで検証する。
- auth-bootstrap deny、Cloud SQL CPU、Calendar queue、background job failureをalert対象にする。

## 3. 実施フェーズ

2026-07-21時点で主要なローカル実装とbaseline checkは完了したが、Phase 0、2、3、4に再修正が必要である。Frontはnode 16件とcomponent/state 5件、build、Back固定digest契約、docs gateが成功している。TerraformはTerraform 1.13.5/provider 7.40.0でfmt/validate、production/Pilot guard 8件、Back固定digest契約、docs gateが成功している。自動testは、nonce欠落、raw claimant ID、main session commit競合、availability/latency alert、container署名producerをまだ検証していない。個別状態は`review-register.md`を正とする。

### 3.1 再修正が必要な既存ID

| ID | 現在の不足 | ローカル完了条件 |
|---|---|---|
| CR-AUTH-001 | ID tokenのnonce claim欠落を許容 | nonce欠落・不一致を拒否するprovider test |
| CR-FRONT-CLAIM-001 | ticket/detail/eventにraw `claimerAttendeeRef`が残る | caller-relative DTOとcontract/negative test |
| CR-FRONT-SESSION-001 | main login/refresh commitにsession epochがなく、Calendar tokenが成功後も残る | reset競合testとtoken消去test |
| CR-INF-HA-001 | production guardは実装済みだが実環境HA未確認 | stagingのfailover/restore/revision切替 |
| CR-INF-OBS-001 | availability/latency alertがない | HCL、validate、alert query test |
| CR-INF-SUPPLY-001 | Backにcontainer push/sign producerがない | 4 imageのdigest/SBOM/provenance/sign workflow |

| Phase | 対象ID | 主な変更 | Exit criteria |
|---|---|---|---|
| 0. 正本更新 | CR-AUTH-001, CR-INF-DB-001, CR-FRONT-CLAIM-001 | OAuth bootstrap例外、DB認証、`claimState`をBack要件・security・OpenAPIへ反映 | OpenAPI validation、文書間の用語・境界一致、decision承認 |
| 1. P0起動経路 | CR-GW-001, CR-INF-002, CR-INF-DB-001 | Gateway/bootstrap実装、probe変更、Connector、IAM DB user/role、migration接続 | stagingでlogin、migration、runtime DB接続、Cloud Run安定稼働 |
| 2. Front security/reliability | CR-FRONT-SEC-001, CR-FRONT-AUTH-001, CR-FRONT-NET-001, CR-FRONT-SESSION-001 | origin/CSP/permission、loopback authority固定、timeout/session cancellation、PII消去 | security negative、request cancellation、logout後PII消去testがPASS |
| 3. Front業務完遂 | CR-FRONT-BOOT-001, CR-FRONT-CLAIM-001, CR-FRONT-OPS-001, CR-FRONT-CONTRACT-001 | 状態機械、claim/transfer、operation/error UI、response validation | 200/202/error/result_unknownを含むcomponent・IPC testがPASS |
| 4. 配布・運用 | CR-FRONT-DIST-001, CR-INF-ALERT-001, CR-INF-STATE-001, CR-INF-IAP-001, CR-INF-HA-001, CR-INF-OBS-001, CR-INF-SUPPLY-001, CR-CI-001 | signed package、IAP client、HA、通知・監視、remote state、image provenance、CI強化 | signed artifact smoke、IAP negative、failover/restore、alert発火、remote state plan、署名image plan、必須CIがPASS |
| 5. 横断受入 | CR-DB-001, CR-IMG-001, CR-GCP-001, CR-TASK-001, CR-INF-001, CR-E2E-001 | 実GCP stagingで全経路を検証 | 全verification gateの証跡を保存し、台帳を`RESOLVED`へ更新 |

## 4. リポジトリ別変更

### Back

1. 認証方式の正本更新とbootstrap service向け内部契約の確定。
2. Gatewayとauth-bootstrap serviceを、個別container targetとして実装する。
3. Cloud SQL connection factoryを追加し、APIとmigrationから共有する。
4. `claimState`をticket responseへadditiveに追加する。
5. response fixtureとGateway/bootstrap/DB接続contract testを追加する。

### Front

1. `will-navigate`をorigin完全一致へ変更し、CSPとpermission denyを追加する。
2. loopback callbackをrandom path、8 KiB上限、有効requestまで待機、確実なcleanupへ変更する。
3. API requestへtimeout/abortを追加し、pollingをsingle-flight化する。
4. bootstrap状態機械、4区分ticket board、transfer、202 operation、calendar cancel、error ackを接続する。
5. response validation、component/IPC/E2E test、Windows x64 signed packageを追加する。macOSを配布対象にする時点でnotarizationをrelease gateへ追加する。

### Terraform

1. Back liveness pathを`/livez`へ変更する。
2. auth-bootstrap service、専用SA、`BOOTSTRAP_SA_EMAIL`、Back invoker IAM、rate-limit前提を追加する。
3. runtime/migration IAM DB user、`roles/cloudsql.instanceUser`、Connector用envを追加する。
4. `bootstrap/state` stackを追加し、versioning、uniform bucket access、public access prevention、最小IAMを設定する。
5. prod notification channelとdigest imageをpreconditionで必須化する。
6. IAP programmatic client、public principal拒否、production HA/deletion protection、追加alertを実装する。
7. Front check、Back契約digest check、tflint、security/image scan、cosign、WIF planをCIへ追加し、Actionsをcommit SHAで固定する。

## 5. PRとdeploy順序

1. **Back-DOC**: Phase 0の意思決定、OpenAPI、security、env契約だけを更新する。
2. **Back-RUNTIME**: Gateway/bootstrap、Cloud SQL connection factory、additive responseを実装する。
3. **Terraform-P0**: probe、service/SA/IAM、Cloud SQL user/envを実装する。`deploy_services=false`でplanを確認する。
4. **Front-SEC**: navigation、CSP、OAuth loopback、network cancellationを先にmergeする。
5. **Front-FLOW**: bootstrap/claim/operation workflowとresponse validationを実装する。
6. **Terraform-OPS**: state、alert、digest validation、CIを実装する。
7. **Front-DIST**: package/sign/smoke CIを実装する。
8. stagingではstate bootstrap、base infrastructure、DB bootstrap/grant、migration job、Back、Gateway/bootstrap、Frontの順にdeployする。

Backのadditive契約を先にmergeし、古いFrontでも動作する期間を設ける。DB migrationは破壊的変更を含めず、runtime切替前に適用する。

## 6. 必須受入試験

### Authentication

- start/callback/redeemが成功し、tokenがbrowser、renderer、URL、logへ出ない。
- handoff replay、expiry、verifier mismatch、任意return URI、oversize body、invalid-first local requestを拒否する。
- bootstrap serviceからBackのredeem以外を呼べないことをnegative IAM testで確認する。

### Cloud Run / Database

- `/livez`は認証なし200、`/v1/health`はuser tokenなし401を維持する。
- Cloud Run revisionがliveness起因で再起動せず30分以上安定する。
- 空DB migration、再実行、checksum不一致、pgvector、rollback対象外の失敗を確認する。
- runtime SAはDDL不可、migration SAは業務データ操作を必要最小限に制限する。

### Front workflow

- provisioning未完了ではticket/eventを取得せず、再開導線だけを表示する。
- unclaimed/mine/waiting/otherを正しく分離し、権限外transferを拒否する。
- approveの200/202、timeout、result_unknown、calendar cancel、critical error ackを完遂する。
- logout、window close、config変更時にrequestとpollingが残らない。
- logout、config変更、401後にmail detail、Calendar、FAQ、operationのPIIがrendererへ残らず、旧session responseが再投入されない。

### Operations / Distribution

- alertを意図的に発火し、通知と復旧通知を確認する。
- 登録済みIAP programmatic clientだけが受理され、public principalと未登録clientが拒否される。
- Cloud SQL failover、PITR/restore、削除拒否とCloud Run revision切替時の可用性を確認する。
- remote stateのversion復元と同時plan競合の防止を確認する。
- 未署名imageとHIGH/CRITICAL脆弱性を持つimageがplan前に拒否される。
- clean端末で署名済みartifactをinstall、login、logoutできることを確認する。

## 7. Release gate

次の条件を全て満たすまでproduction releaseを許可しない。

- `CR-AUTH-001`、`CR-GW-001`、`CR-INF-002`、`CR-INF-DB-001`が`RESOLVED`。
- `CR-INF-IAP-001`、`CR-INF-HA-001`が`RESOLVED`。
- Back `npm run check`、Front `npm run check`、Terraform fmt/validate/contract/security checkが全てPASS。
- secretを含まないstaging planと、Cloud Run/IAP/Cloud SQLの実環境証跡がある。
- rollback対象の直前Cloud Run revision、DB backup/PITR、前版signed Front artifactを特定できる。
- `review-register.md`の該当IDへtestまたはstaging証跡が記録されている。

## 8. 実装前に確定する外部入力

推奨defaultを括弧内に示す。

1. auth-bootstrap serviceの限定公開を許可するか（許可し、redeemだけを公開）。
2. 初期配布OS（Windows x64）。
3. production notification channel resource名と一次対応者。
4. remote state用project、bucket命名、CI principal。
5. 初回DB role/grantを実行するoperatorと証跡保存先。
6. cosign certificate identity regexpとOIDC issuer。
