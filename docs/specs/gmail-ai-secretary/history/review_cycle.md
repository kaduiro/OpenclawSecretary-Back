Status: DRAFT
Source: chat
Work item: gmail-ai-secretary
Upstream inputs: requirements_definition.md v8.14 (updated 2026-07-09), design.md v4.12, process_flow_design.md v2.6, openapi.yaml v1.5.0, db_design_document.md v1.9, db_columns_list_with_relations.md v1.5, er_diagram.md v1.9, infra_architecture_design.md v1.5, security_design.md v1.6, UseCase_List.md v1.3, tasks.md (updated 2026-06-25), test_plan.md v0.8
Last updated by: Codex

# Review Cycle: gmail-ai-secretary

Created: 2026-06-03 | Version: 0.3 | Status: DRAFT

---

注記: Iteration 1〜6 の OPEN / STILL_CONFIRM_REQUIRED 表および過去の `残存 OPEN QUESTION` は当時のレビュー履歴として残す。現行の確認待ち状態は末尾の最新 Iteration と `現行残存確認ゲート` を正とする。

---

## 目的

`docs/specs/gmail-ai-secretary` 配下の要件・設計・API・DB・セキュリティ・テスト計画を周期的にレビューし、重大な設計判断をユーザー確認待ちとして分離したうえで、低リスクな整合性修正を継続的に反映する。

---

## 反復手順

1. 要件・ユースケース観点、セキュリティ・インフラ観点、API/DB/テスト整合性観点に分けてレビューする。
2. 指摘を `確認必須`、`修正推奨`、`軽微` に分類する。
3. `確認必須` は既存仕様へ採用せず、OPEN QUESTION として記録する。
4. `修正推奨` と `軽微` のうち、要件・アーキテクチャ・権限・データ保持方針を変えないものだけ即時反映する。
5. 更新後に、影響文書・残課題・次回レビュー対象を本ファイルに追記する。

---

## Iteration 1: 2026-06-03

### 使用エージェント

| 担当 | 対象 | 主な観点 |
|---|---|---|
| 要件・ユースケースレビュー | requirements_definition.md, UseCase_List.md, process_flow_design.md, lean-rtm.md, tasks.md | 要件矛盾、MVP範囲、受け入れ条件、重大確認事項 |
| セキュリティ・インフラレビュー | security_design.md, infra_architecture_design.md, db_design_document.md, er_diagram.md, openapi.yaml | OAuth/IAM、PII、監査、テナント分離、運用権限 |
| 仕様間整合性・テストレビュー | design.md, openapi.yaml, db_design_document.md, test_plan.md, tasks.md, lean-rtm.md, codebase-context.md, discovery-context.md | API/DB/設計/テストの不整合、検証可能性 |

---

## 確認必須事項（Iteration 1 時点の履歴）

以下は重要または抜本的な改善に該当するため、ユーザー確認なしに仕様へ採用しない。

| ID | 状態 | 論点 | 推奨方針案 | 影響文書 |
|---|---|---|---|---|
| RC-AUTH-001 | CLOSED / UPDATED 2026-06-09 | HUD が IAM Credentials `generateIdToken` を呼ぶには、Gmail/Calendarの5スコープだけでは不足する可能性がある | 2026-06-03 の「Google OAuth PKCE ユーザーID token direct 使用」判断は 2026-06-09 設計で更新済み。現行は Gateway/backend handoff の短命 ID token を `openclaw-hud-gateway` へ送り、`openclaw-api` direct invoker は gateway SA / Scheduler SA / Tasks SA のみに限定する。IAM Credentials API generateIdToken は引き続き不採用 | requirements_definition.md, security_design.md, openapi.yaml |
| RC-AUTH-002 | CONFIRM_REQUIRED | Gmail `gmail.readonly` / `gmail.compose` は restricted scope で、サーバー保存時の審査・セキュリティ評価が必要になり得る | 内部Workspace限定か公開アプリかを確定し、OAuth verification、security assessment、ユーザーデータ削除申請の責任者と手順を設計に追加する | requirements_definition.md, security_design.md, db_design_document.md |
| RC-AUTH-003 | CLOSED | Gmail `gmail.compose` は下書き送信も含むため、`gmail.send` が冗長な可能性がある | gmail.send 削除。4スコープ（gmail.readonly・gmail.compose・calendar.events・openid）に確定。2026-06-03 ユーザー確認済み | requirements_definition.md, security_design.md, lean-rtm.md |
| RC-TENANT-001 | CONFIRM_REQUIRED | 1ユーザー1環境と同一プロジェクト/独立スキーマ案が混在し、DBに tenant_id / RLS がない | MVPは「1ユーザー1GCPプロジェクトまたは1Cloud SQL」に固定する。横展開する場合は tenant_id、RLS、ユーザー別SA、Secret/DB分離を設計する | security_design.md, db_design_document.md, infra_architecture_design.md |
| RC-PII-001 | CONFIRM_REQUIRED | `timeline_events` / Calendar操作履歴 / Cloud SQLバックアップ上のPII保持が未確定 | 法務確認までは監査payloadをPII非保持・疑似識別子化へ寄せる。保持例外を採用する場合は法務承認済み例外として明記する | requirements_definition.md, security_design.md, db_design_document.md, er_diagram.md, test_plan.md |
| RC-CAL-001 | CONFIRM_REQUIRED | Calendar候補スロットの正本が `design.md` とDB設計で不一致 | `calendar_proposals` を正本にし、全拒否は物理削除ではなく `status='rejected'` に統一する案を優先する | design.md, db_design_document.md, process_flow_design.md, openapi.yaml |
| RC-CAL-002 | CONFIRM_REQUIRED | Calendar衝突情報・参加者名・既存予定名のHUD表示範囲がPII制約と衝突 | MVPは busy/free、衝突有無、手動確認要否のみ表示し、メールアドレス・表示名・予定名は法務/UX確認後に許可する | requirements_definition.md, design.md, process_flow_design.md, UseCase_List.md, security_design.md, openapi.yaml |
| RC-DWD-001 | CONFIRM_REQUIRED | Domain-wide Delegation の書き込み対象が組織ドメイン判定だけでは弱い | 書き込み対象ユーザー/グループ allowlist と監査レビューを追加し、対象外ユーザーは候補提示のみまたは手動補正にする | requirements_definition.md, security_design.md, process_flow_design.md |
| RC-FAQ-001 | CONFIRM_REQUIRED | FAQ管理が「登録のみ」か「編集/無効化/カテゴリ/プロンプト更新」まで含むか不一致 | MVPはFAQ候補登録・手動追加のみ。編集/無効化/カテゴリ/プロンプト更新はOpenAPI追加後の拡張にする案を優先する | requirements_definition.md, UseCase_List.md, tasks.md, openapi.yaml |
| RC-COMPAT-001 | CLOSED | OS対応が macOS/Windows/Linux Must と Windows11先行で揺れている | macOS 13+ / Windows 11 / Linux (Ubuntu 22.04+) 3OS Must に確定。2026-06-03 ユーザー確認済み | requirements_definition.md, lean-rtm.md, tasks.md, test_plan.md |
| RC-TLS-001 | CLOSED | `TLS 1.3固定` はGoogle APIs/Cloud Runのネゴシエーションをアプリ側で完全固定できるか不明 | HTTPS 必須・TLS 1.2 以上・TLS 1.3 優先に緩和。2026-06-03 ユーザー確認済み | requirements_definition.md, security_design.md, lean-rtm.md, test_plan.md |

---

## 修正推奨事項（Iteration 1 時点の履歴）

| ID | 状態 | 論点 | 推奨更新 |
|---|---|---|---|
| RC-TOKEN-001 | CLOSED | `approvalToken` が短命なのにカードはタイムアウトなしで有効という矛盾がある | approvalToken 期限切れ時に HUD が副作用ボタン disabled、polling 再取得の動作を design.md に追記済み |
| RC-TEST-001 | CLOSED | TASK-014 がPhase 4扱いだが、安全系Test-RefはTASK-004/007/009/011/012完了前ゲート | tasks.md / test_plan.md / lean-rtm.md でPhase 1並行ゲートとして反映済み |
| RC-API-001 | CLOSED | `/v1/health` のOpenAPIレスポンスとタスク完了条件が不一致 | openapi.yaml の HealthResponse に revision / db / heartbeat を追加済み |
| RC-API-002 | CLOSED | `Event.payload` がOpenAPIでは任意、DBでは必須 | openapi.yaml の Event.required に payload を追加済み |
| RC-OPS-001 | OPEN | `event_inbox` cleanup がinfra/taskに未反映 | `/internal/retention/pii-mask` へACK済み7日削除を統合するか、専用cleanup endpoint/Schedulerを追加する |
| RC-RATE-001 | OPEN | `max-instances=1/concurrency=1` はDoS対策にならない | 429、endpoint別token bucket、approvalToken試行制限、Cloud Tasks queue rateを設計に追加する |
| RC-MIG-001 | OPEN | 旧SQLite移行の検証粒度が不足 | 旧schema対応表、dry-run、件数/checksum照合、backup/rollback、PIIマスク後データ移行可否を追加する |
| RC-API-003 | CLOSED | `event_inbox` cursor仕様がOpenAPIとDBカラム一覧で不一致 | openapi.yaml の cursor 説明を opaque string に createdAt + eventId をエンコードする方針へ更新済み |
| RC-DB-001 | CLOSED | db_columns_list_with_relations.md の `timeline_events.operator` 説明がDB設計のMVP指針と不一致 | 法務確認完了まで `operator` にPIIを保存せず、`detail` もallowlist化した非PIIのみ保存する記述へ更新済み |

---

## Iteration 2: 2026-06-03

### 使用エージェント

| 担当 | 対象 | 主な観点 |
|---|---|---|
| 要件・ユースケース継続レビュー | requirements_definition.md, UseCase_List.md, process_flow_design.md, lean-rtm.md, tasks.md, test_plan.md | Iteration 1 OQの解消/悪化判定、MVP範囲、要件承認状態 |
| セキュリティ・インフラ継続レビュー | security_design.md, infra_architecture_design.md, db_design_document.md, db_columns_list_with_relations.md, er_diagram.md, openapi.yaml | OAuth/IAM、restricted scope、テナント分離、PII、DwD、token、rate limit |
| API・DB・テスト整合性継続レビュー | design.md, openapi.yaml, db_design_document.md, db_columns_list_with_relations.md, er_diagram.md, test_plan.md, tasks.md, lean-rtm.md, codebase-context.md | OpenAPI/DB/設計/テストの型・状態・enum・endpoint整合 |

### 状態更新

| ID | 状態 | 判定 | 次アクション |
|---|---|---|---|
| RC-AUTH-001 | CLOSED / UPDATED 2026-06-09 | HUD `generateIdToken` とGmail/Calendar scope定義の不整合 | 現行は Gateway/backend handoff の短命 ID token を使用し、backend confidential exchange が OAuth client secret / refresh token を管理する。IAM Credentials API generateIdToken は不採用。Cloud Run IAM は `openclaw-api` direct invoker を gateway SA / Scheduler SA / Tasks SA に限定し、HUD 利用者は `openclaw-hud-gateway` の IAP で認可する |
| RC-AUTH-002 | STILL_CONFIRM_REQUIRED | Gmail restricted scope 対応責任者、内部Workspace限定/公開アプリ方針が未解決 | OAuth verification / security assessment / User Data Policy の責任者をユーザー確認 |
| RC-AUTH-003 | CLOSED | `gmail.send` 要否が未決定 | gmail.send 削除。4スコープ（gmail.readonly・gmail.compose・calendar.events・openid）に確定。2026-06-03 ユーザー確認済み |
| RC-TENANT-001 | STILL_CONFIRM_REQUIRED | 1ユーザー1環境、同一プロジェクト、独立schema案が混在 | MVP分離単位を「1ユーザー1GCPプロジェクト/1Cloud SQL」へ固定するか、共有基盤設計を追加するか確認 |
| RC-PII-001 | STILL_CONFIRM_REQUIRED | DB設計には暫定PII非保持指針が入ったが、security/ER/designにOSユーザー名・Calendar PII表示記述が残る | 法務確認まで非表示/疑似識別子化に寄せるか、保持例外を承認するか確認 |
| RC-CAL-001 | CLOSED | `calendar_proposals.slots` 正本化と `status='rejected'` が DB/RTM/requirements/design に反映済み | Calendar正本不整合は解消。Calendar PII表示範囲は RC-CAL-002 として継続確認 |
| RC-CAL-002 | STILL_CONFIRM_REQUIRED | Calendar参加者名・メール・既存予定名のHUD/API露出は未決定 | MVPはbusy/free・衝突有無・手動確認要否のみとするか確認 |
| RC-DWD-001 | STILL_CONFIRM_REQUIRED | DwD書き込み対象allowlistが未定義 | 対象ユーザー/グループallowlistと対象外時の動作を確認 |
| RC-FAQ-001 | STILL_CONFIRM_REQUIRED | OQ-RC-007はOPENだが、OQ-FAQ-001やREQ-MAINTが編集/カテゴリ/プロンプト更新まで含む | MVPを登録/手動追加のみへ絞るか、API/タスクを拡張するか確認 |
| RC-COMPAT-001 | CLOSED | 3OS MustとWindows11先行が混在 | macOS 13+ / Windows 11 / Linux (Ubuntu 22.04+) 3OS Must に確定。2026-06-03 ユーザー確認済み |
| RC-TLS-001 | CLOSED | TLS 1.3固定が残る | HTTPS 必須・TLS 1.2 以上・TLS 1.3 優先に緩和。2026-06-03 ユーザー確認済み |
| RC-OPS-001 | OPEN | DB側にACK済み7日削除はあるが infra/tasks/test_plan に未反映 | retention job統合または専用cleanup jobを次回反映 |
| RC-RATE-001 | OPEN | rate limit / 429 / approvalToken試行制限が未定義 | security/infra/OpenAPI/test_planへ追加 |
| RC-MIG-001 | OPEN | migration検証が件数一致中心で不足 | schema対応表、dry-run、checksum、rollback、PIIマスク後データ移行可否を追加 |

### Iteration 2 即時反映

- openapi.yaml: `HealthResponse` に `revision`、`db.status`、`db.latencyMs`、`heartbeat.status`、`heartbeat.checkedAt` を追加。
- openapi.yaml: `Event.required` に `payload` を追加。
- openapi.yaml: `/v1/events` cursor を opaque string とし、createdAt + eventId をエンコードする実装方針を追記。
- db_columns_list_with_relations.md: `timeline_events.operator` / `detail` のMVP PII非保持指針をDB設計書と同期。
- design.md / requirements_definition.md: Calendar候補スロット正本を `calendar_proposals.slots` に統一し、全拒否を物理削除ではなく `status='rejected'` 更新として同期。

### Iteration 2 保留（履歴）

以下は重要または抜本的な判断を伴うため、ユーザー確認前に採用しない。

- OAuth/IAM scope設計、Gmail restricted scope審査、`gmail.send` 削除可否。
- テナント分離モデル。
- Calendar/監査PIIの表示・保持・疑似識別子化。
- DwD書き込み対象allowlist。
- FAQ管理MVP範囲。
- Windows先行か3OS Mustか。
- TLS要件の緩和。

---

## Iteration 3: 2026-06-03

### Iteration 3 即時反映

- requirements_definition.md v8.9: RC-AUTH-001/003/COMPAT-001/TLS-001 の設計変更を反映。OQ-RC-001/003/008/009 CLOSED。
- design.md v4.6: TokenManager 認証方式変更・gmail.send 削除・approvalToken 期限切れ動作追記。
- security_design.md: OAuth スコープ・TLS・HUD認証フローを更新。
- lean-rtm.md v8.9: REQ-NET-001/AUTH-003/SEC-001/SEC-003/COMPAT-001 Statement 更新。
- infra_architecture_design.md: TLS・IAM権限更新。
- process_flow_design.md v2.0: TLS・approvalToken 期限切れ動作追記。

### 過去の OPEN QUESTION（Iteration 3 時点）→ **全件 Iteration 7 で解消済み**

> この時点では以下が未解消でした。解決内容は Iteration 7 を参照してください。

| ID | Iteration 3 時点の状態 | 解消 |
|---|---|---|
| RC-AUTH-002 | Gmail restricted scope 審査・責任者未定 | Iteration 7 CLOSED |
| RC-TENANT-001 | テナント分離モデル未確定 | Iteration 7 CLOSED |
| RC-PII-001 | PII 保持ポリシー法務確認待ち | Iteration 7 CLOSED |
| RC-CAL-002 | Calendar 衝突情報 HUD 表示範囲未確定 | Iteration 7 CLOSED |
| RC-DWD-001 | DwD allowlist 未定義 | Iteration 7 CLOSED |
| RC-FAQ-001 | FAQ管理 MVP 範囲未確定 | Iteration 7 CLOSED |
| RC-OPS-001 | event_inbox cleanup 未反映 | Iteration 4 CLOSED |
| RC-RATE-001 | rate limit 未設計 | Iteration 4 CLOSED |
| RC-MIG-001 | SQLite 移行検証粒度不足 | Iteration 4 CLOSED |

---

## Iteration 4: 2026-06-03

### 使用エージェント

| 担当 | 対象 | 主な観点 |
|---|---|---|
| 仕様整合レビュー | requirements_definition.md, design.md, lean-rtm.md, tasks.md, UseCase_List.md | 確認済み決定の反映漏れ、MVP範囲、古いスコープ/TLS表現 |
| セキュリティ/PIIレビュー | security_design.md, design.md, openapi.yaml, db_design_document.md, db_columns_list_with_relations.md, process_flow_design.md | restricted scope、PII、approvalToken、rate limit |
| 運用/移行/テストレビュー | infra_architecture_design.md, test_plan.md, tasks.md, openapi.yaml, db_design_document.md | event cleanup、429、Cloud Tasks rate、SQLite移行検証 |

### Iteration 4 即時反映

- openapi.yaml v1.3.2: HUD向けエンドポイントに `429 Too Many Requests` / `rate_limited` / `Retry-After` を追加。`/internal/retention/pii-mask` の責務を PII masking + `event_inbox` cleanup に拡張。
- design.md v4.7: `TLS 1.3` 固定表現を HTTPS必須・TLS 1.2以上・TLS 1.3優先へ修正。`calendar.readonly` を `calendar.events` に同期。AI分析の8項目表記を10項目へ修正。retention handler と 429 方針を追記。
- security_design.md v1.2: `timeline_events.operator` のMVP PII非保持方針、endpoint別token bucket、approvalToken連続失敗制限、Cloud Tasks queue rate を追加。`iam.serviceAccountOpenIdTokenCreator` 旧検証文言を削除。
- infra_architecture_design.md v1.2: 3OS Must、retention job への `event_inbox` cleanup統合、Cloud Tasks `maxDispatchesPerSecond=1` / `maxConcurrentDispatches=1`、rate limit設計を追加。
- tasks.md v2.5: TASK-002/004/008/011/012/013/014 に SQLite移行検証、429、approvalToken試行制限、event cleanup、Cloud Tasks queue rate を追加。TASK-008 の `generateIdToken` 旧方式を削除。
- db_design_document.md v1.2: SQLite移行検証に旧schema対応表、dry-run、件数/checksum照合、backup/rollback を追加。
- requirements_definition.md v8.10: `gmail.send scope`、承認操作者OSユーザー名、v8.4の `generateIdToken` 旧決定を現行方針へ同期。REQ-NET-003 と REQ-COMPLY-001 に 429 / event cleanup 条件を追加。
- process_flow_design.md v2.1: 「カードは有効」の表現を、表示カードは残るが `tokenExpiresAt` 後の副作用ボタンは disabled とする表現へ修正。
- test_plan.md v0.3: TP-RATE-001 / TP-OPS-001 / TP-MIG-001 を追加。

### Iteration 4 状態更新

| ID | 状態 | 更新内容 |
|---|---|---|
| RC-OPS-001 | CLOSED | `event_inbox` ACK済み7日削除は既存 `/internal/retention/pii-mask` 日次retention jobへ統合する方針で設計・タスク・テストへ反映 |
| RC-RATE-001 | CLOSED | `429 rate_limited`、endpoint別token bucket、approvalToken連続失敗制限、Cloud Tasks queue rateを設計・OpenAPI・タスク・テストへ反映 |
| RC-MIG-001 | CLOSED_PARTIAL | SQLite移行のdry-run、schema対応表、件数/checksum、backup/rollbackを反映。PIIマスク済み/90日超データの移行可否は RC-PII-001 に連動して確認待ち |
| RC-AUTH-001-DRIFT | CLOSED | tasks.md / openapi.yaml / requirements_definition.md の `generateIdToken` 旧記述を修正 |
| RC-TLS-001-DRIFT | CLOSED | design.md の `TLS 1.3` 固定表現を緩和済み要件へ同期 |
| RC-AUTH-003-SCOPE | CLOSED | design.md / requirements_definition.md の `calendar.readonly` と `gmail.send scope` 残存記述を修正 |
| RC-PII-001-DRIFT | CLOSED_PARTIAL | `timeline_events.operator` は法務確認完了まで NULL またはシステム識別子とする文言へ同期。Calendar PII保持・表示範囲は継続確認 |

### 過去の OPEN QUESTION（Iteration 4 時点）→ **全件 Iteration 7 で解消済み**

> この時点では以下が未解消でした。解決内容は Iteration 7 を参照してください。

| ID | Iteration 4 時点の状態 | 解消 |
|---|---|---|
| RC-AUTH-002 | Gmail restricted scope 審査・責任者・公開アプリ方針未確定 | Iteration 7 CLOSED |
| RC-TENANT-001 | テナント分離モデル（1GCPプロジェクト vs 1Cloud SQL vs 共有基盤）未確定 | Iteration 7 CLOSED |
| RC-PII-001 | Calendar操作履歴・Cloud SQL backup・PII保持ポリシー法務確認待ち | Iteration 7 CLOSED |
| RC-CAL-002 | Calendar 衝突情報・参加者名/メール/既存予定名の HUD 表示範囲未確定 | Iteration 7 CLOSED |
| RC-DWD-001 | DwD allowlist と対象外時の動作未定義 | Iteration 7 CLOSED |
| RC-FAQ-001 | FAQ管理 MVP 範囲未確定 | Iteration 7 CLOSED |
| RC-TOKEN-001-HASH | approvalToken DB ハッシュ保存・単回使用・バインドの採用可否未確定 | Iteration 7 CLOSED |

---

## 外部仕様確認

- Gmail API scope: Google公式では `gmail.compose` は下書きの作成/更新/削除とメッセージ・下書き送信を含み、`gmail.readonly` / `gmail.compose` は restricted scope に分類される。
- IAM Credentials `generateIdToken`: Google公式では `https://www.googleapis.com/auth/iam` または `https://www.googleapis.com/auth/cloud-platform` のいずれかのOAuth scopeが必要。
- Cloud Run ID token audience: Google公式では、IAM保護されたCloud Runを呼ぶID tokenの `aud` は通常サービスURL、またはサービスに設定したcustom audienceに一致させる必要がある。

| 対象 | 参照URL |
|---|---|
| Gmail API scopes | https://developers.google.com/workspace/gmail/api/auth/scopes |
| IAM Credentials `generateIdToken` | https://docs.cloud.google.com/iam/docs/reference/credentials/rest/v1/projects.serviceAccounts/generateIdToken |
| Cloud Run custom audience | https://docs.cloud.google.com/run/docs/configuring/custom-audiences |

---

## 今回の即時反映範囲

- Iteration 4 のレビュー記録を追加する。
- 確認済み決定の反映漏れ（`generateIdToken`、`gmail.send`、`calendar.readonly`、TLS 1.3固定、OSユーザー名保存）を修正する。
- `event_inbox` cleanup、429/rate limit、SQLite移行検証を低リスク運用設計として反映する。
- 重要判断が必要な PII / restricted scope / テナント / DwD / FAQ / approvalToken hash は OPEN QUESTION として残す。

---

## Iteration 5: 2026-06-03

### 使用エージェント

| 役割 | 対象 | 主な観点 |
|---|---|---|
| 要件・UXスコープレビュー | requirements_definition.md, UseCase_List.md, tasks.md, lean-rtm.md, review_cycle.md | RC-AUTH-002 / RC-TENANT-001 / RC-DWD-001 / RC-FAQ-001 のゲート接続 |
| Security / PII / tokenレビュー | security_design.md, db_design_document.md, db_columns_list_with_relations.md, openapi.yaml, process_flow_design.md | RC-PII-001 / RC-CAL-002 / RC-TOKEN-001-HASH の未確定範囲 |
| API / DB / Test整合レビュー | openapi.yaml, db_design_document.md, db_columns_list_with_relations.md, er_diagram.md, tasks.md, test_plan.md | version参照、429契約、event cursor、先行Test-Ref |

### Iteration 5 即時反映

- openapi.yaml v1.3.3: `TooManyRequests` に `Retry-After` 必須注記と `rate_limited` example を追加。`rate_limit_exceeded` はMVP非実装コメントから backward-compatible alias 注記へ修正。
- openapi.yaml v1.3.3: Calendar PII payload（`participantContexts` / `unavailableAttendees` / `conflictInfo`）に RC-CAL-002 の Legal/UX 確認ゲートを追記。
- openapi.yaml v1.3.3: `Event.payload` は `Event.type` と一致しない組み合わせを拒否する実装方針を追記。
- db_design_document.md / db_columns_list_with_relations.md: `event_inbox` cursor を opaque string（`created_at + event_id`）に統一し、index を `idx_event_inbox_is_acked_created_at_event_id` へ同期。
- db_design_document.md / db_columns_list_with_relations.md / er_diagram.md: `approval_token` は RC-TOKEN-001-HASH 解消まで平文保存確定仕様として扱わない注記を追加。
- UseCase_List.md / discovery-context.md / tasks.md / lean-rtm.md: OQ-RC-007 CLOSED に合わせ、FAQ MVP を `POST /v1/faqs` による候補登録・手動追加のみへ同期。編集/無効化/カテゴリタグ変更は将来拡張扱い。
- tasks.md / test_plan.md / lean-rtm.md: 先行 Test-Ref を6件表現から12件表現へ同期。
- design.md / requirements_definition.md / process_flow_design.md / infra_architecture_design.md / security_design.md / db_design_document.md / db_columns_list_with_relations.md / er_diagram.md / UseCase_List.md / tasks.md / test_plan.md: 現行関連文書参照を openapi.yaml v1.3.3、requirements_definition.md v8.10、process_flow_design.md v2.1、db_design_document.md v1.2、lean-rtm.md v8.10、security_design.md v1.2 へ同期。

### 過去の残存確認ゲート（Iteration 5 時点）→ **全件 Iteration 7 で解消済み**

| ID | Iteration 5 時点の状態 | 解消 |
|---|---|---|
| RC-TENANT-001 | CONFIRM_REQUIRED（MVP分離単位未確定） | Iteration 7 CLOSED：1ユーザー1GCPプロジェクト + 1Cloud SQL に固定 |
| RC-PII-001 | CONFIRM_REQUIRED（法務確認待ち） | Iteration 7 CLOSED：90日保持確定・Calendar/監査PII非保持 |
| RC-CAL-002 | CONFIRM_REQUIRED（Legal/UX確認待ち） | Iteration 7 CLOSED：MVP は busy/free・衝突有無・手動確認要否のみ |
| RC-DWD-001 | CONFIRM_REQUIRED（対象外時動作未定義） | Iteration 7 CLOSED：スキップ + HUD 手動補正要通知・非PII監査 |
| RC-TOKEN-001-HASH | CONFIRM_REQUIRED（採用可否未確定） | Iteration 7 CLOSED：SHA-256 ハッシュ保存・単回使用・バインド採用 |

### 状態更新

| ID | 状態 | 更新内容 |
|---|---|---|
| RC-AUTH-002 | CLOSED_WITH_RELEASE_NOTE | OQ-RC-002 / OQ-SEC-007 により社内 Workspace Internal app・外部公開なし・Google OAuth security assessment/verification不要で確認済み。外部公開へ変更する場合は再OPEN |
| RC-FAQ-001 | CLOSED | OQ-RC-007 により FAQ MVP は登録/手動追加のみ。編集/無効化/カテゴリタグ変更は将来拡張 |
| RC-DWD-001 | CLOSED_PARTIAL | `dwdAllowlistEmails` field と組織ドメインAND allowlist判定は反映済み。対象外時動作・監査レビューは残存確認ゲートとして継続 |
| RC-OPS-001 | CLOSED | Iteration 4の反映済み状態を現行ゲート表から除外 |
| RC-RATE-001 | CLOSED | 429 / token bucket / approvalToken試行制限 / queue rate はOpenAPI・設計・test_planへ反映済み |
| RC-MIG-001 | CLOSED_PARTIAL | dry-run / schema map / count+checksum / backup+rollback は反映済み。PII移行可否は RC-PII-001 に連動 |

---

## Iteration 6: 2026-06-03

### 使用エージェント

| 役割 | 対象 | 主な観点 |
|---|---|---|
| 要件・UXスコープレビュー | requirements_definition.md, UseCase_List.md, tasks.md, lean-rtm.md, review_cycle.md | FAQ MVP、DwD残存ゲート、テナント分離ゲート、Test-Ref表現 |
| Security / PII / tokenレビュー | security_design.md, db_design_document.md, db_columns_list_with_relations.md, er_diagram.md, openapi.yaml, process_flow_design.md | Calendar PII、承認者識別子、approvalToken保存方式、DwD監査粒度 |
| API / DB / Test整合レビュー | openapi.yaml, db_design_document.md, db_columns_list_with_relations.md, tasks.md, test_plan.md | OpenAPI 3.1 nullable、Event type/payload binding、429契約、event_inbox index |

### Iteration 6 即時反映

- openapi.yaml v1.3.4: OpenAPI 3.1.0 に合わせ、`nullable: true` を JSON Schema 2020-12 の `type: [..., "null"]` 表現へ変換。
- openapi.yaml v1.3.4: `Event.type` と `payload` の組み合わせを `oneOf` + `const` でスキーマ上も拘束。
- openapi.yaml v1.3.4: 429応答を `code: rate_limited` に制約し、Calendar PII項目（参加者表示名・メール等）は RC-CAL-002 解消まで optional/null とする表現へ同期。
- db_design_document.md / db_columns_list_with_relations.md: `event_inbox` 未ACK取得 index を `(created_at, event_id) WHERE is_acked=false` の partial index として明確化。
- db_design_document.md / db_columns_list_with_relations.md / er_diagram.md: `calendar_operations.approver_user_id` をPII保持カラムとして明示し、平文OSユーザー名固定ではなく OQ-DB-002 / OQ-SEC-004 に連動させる。
- db_columns_list_with_relations.md / er_diagram.md: `approval_token` 保存方式を OQ-DB-006 / OQ-SEC-009 / RC-TOKEN-001-HASH に接続。
- requirements_definition.md / design.md: FAQ MVPを `POST /v1/faqs` による候補登録・手動追加のみへ再同期し、編集・無効化・FAQカテゴリタグ変更は将来拡張と明記。
- tasks.md / test_plan.md: 先行ゲート表現を「先行12件、うち副作用系6件」に整理。
- security_design.md / process_flow_design.md / lean-rtm.md: Calendar PII、DwD対象外時動作、テナント分離単位が残存確認ゲートであることを追記。

### 過去の残存確認ゲート（Iteration 6 時点）→ **全件 Iteration 7 で解消済み**

| ID | Iteration 6 時点の状態 | 解消 |
|---|---|---|
| RC-TENANT-001 | CONFIRM_REQUIRED（分離単位未確定） | Iteration 7 CLOSED：1ユーザー1GCPプロジェクト + 1Cloud SQL に固定 |
| RC-PII-001 | CONFIRM_REQUIRED（法務確認待ち） | Iteration 7 CLOSED：90日保持確定・Calendar/監査PII非保持 |
| RC-CAL-002 | CONFIRM_REQUIRED（Legal/UX確認待ち） | Iteration 7 CLOSED：MVP は busy/free・衝突有無・手動確認要否のみ |
| RC-DWD-001 | CONFIRM_REQUIRED（対象外時動作未定義） | Iteration 7 CLOSED：スキップ + HUD 手動補正要通知・非PII監査 |
| RC-TOKEN-001-HASH | CONFIRM_REQUIRED（採用可否未確定） | Iteration 7 CLOSED：SHA-256 ハッシュ保存・単回使用・バインド採用 |

---

## 次回レビュー対象（Iteration 6 時点の履歴）

1. RC-TENANT-001 のMVP分離単位を確認し、security / infra / DB / tasks のブロック表現を解除または共有基盤設計へ拡張する。
2. RC-PII-001 / RC-CAL-002 の決定に合わせて、Calendar payload、DB保持、OpenAPI、test_planを更新する。
3. RC-DWD-001 の対象外時動作・通知文言・監査レビュー粒度を確認し、requirements/security/process_flow/tasksへ反映する。
4. RC-TOKEN-001-HASH の採否を確認し、approvalToken のDB保存方式を db_design_document / db_columns_list_with_relations / er_diagram / security_design / openapi.yaml へ反映する。
5. OpenAPI v1.3.4 の `oneOf` / nullable 表現が利用予定のコード生成・バリデーションツールで問題ないかを実装前に検証する。

---

## Iteration 7: 2026-06-04

### 状態更新（残存 OPEN QUESTION 全件解消）

| ID | 状態 | 解決内容 | ユーザー確認日 |
|---|---|---|---|
| RC-AUTH-002 | **CLOSED** | Gmail API は社内 Google Workspace Internal アプリ・外部公開なし確定済み。Google OAuth verification / security assessment 不要。外部ユーザー公開に変える場合だけ再OPEN。既に cycle 10 で CLOSED 済み | 2026-06-04（再確認） |
| RC-TENANT-001 | **CLOSED** | MVP は「1ユーザー1GCPプロジェクト + 1ユーザー1Cloud SQL」に固定。共有基盤・tenant_id・RLS は MVP 対象外。PII/RAG 混在リスクを構造的に排除 | 2026-06-04 |
| RC-PII-001 | **CLOSED** | MVP: emails・sent_reply_embeddings を90日保持後マスク。Calendar/監査PII（timeline_events.operator等）は非保持・疑似識別子化。Cloud SQL backup 7日は暗号化+IAM制限+保持期間明記で対応。180日保持・例外保持は法務承認後のみ | 2026-06-04 |
| RC-CAL-002 | **CLOSED** | MVP の HUD 表示は busy/free・衝突有無・手動確認要否のみ。参加者名・メールアドレス・既存予定名は HUD/API に出さない。Legal/UX 承認後に段階解放 | 2026-06-04 |
| RC-DWD-001 | **CLOSED**（設計詳細化） | allowlist 対象外はCalendar書き込みをスキップし、HUDに「手動補正要」と通知。監査には非PII（operationId/status/correlationId）中心 | 2026-06-04 |
| RC-FAQ-001 | **CLOSED** | MVP は POST /v1/faqs による FAQ 候補登録・手動追加のみ。既に cycle 10 で CLOSED 済み | 2026-06-04（再確認） |
| RC-TOKEN-001-HASH | **CLOSED**（新規採用） | approvalToken は DB に平文保存せず SHA-256 ハッシュのみ保存。単回使用・mailId（またはproposalId）/承認者userId/cardVersion/期限バインド。MVP で採用 | 2026-06-04 |

### Iteration 7 即時反映

- requirements_definition.md v8.11: RC-TENANT-001/PII-001/CAL-002 CLOSED・OQ-COMPLY-001/OQ-RC-004/OQ-RC-006 CLOSED・REQ-AUTH-002 DwD fail-closed・REQ-HUD-003/REQ-CAL-004 approvalToken ハッシュ要件追加
- design.md v4.8: approvalToken SHA-256ハッシュ設計・emails token保持カラム・conflictInfo MVP null固定・CalendarOperationResult attendee_ref 疑似識別子化
- security_design.md v1.3: approvalToken セキュリティ設計追加・テナント分離確定・PII保持方針確定・DwD fail-closed・Calendar operation results 非PII分類へ更新
- db_design_document.md / db_columns_list_with_relations.md / er_diagram.md: Gmail/Calendar approvalToken ハッシュ保存、event_inbox平文非保持、attendee_ref 疑似識別子化、OQ-DB-002/003/006 CLOSEDを同期
- infra_architecture_design.md v1.3: MVP を 1ユーザー1GCPプロジェクト + 1ユーザー1Cloud SQL に固定し、OQ-INFRA-006 CLOSEDへ更新
- openapi.yaml v1.3.6: event_inbox payload から approvalToken を除外し、Calendar PII項目をMVPで null/空配列固定、DwD allowlist 空配列 fail-closed として定義
- process_flow_design.md v2.3: event_inbox token非保持、DwD fail-closed、operation/result の参加者PII非表示・疑似識別子化を反映
- tasks.md v2.6 / test_plan.md v0.4 / lean-rtm.md v8.11 / UseCase_List.md: 追加 Test-Ref（TP-TENANT-001、TP-PII-002、TP-CAL-PII-001、TP-DWD-001、TP-TOKEN-001）とCLOSED方針を同期

### 残存 OPEN QUESTION（Iteration 7 時点の履歴）

**すべての CONFIRM_REQUIRED 項目が解消されました。**

将来 OPEN になりうる項目:
- RC-AUTH-002 再OPEN（外部ユーザー公開に変える場合）
- RC-CAL-002 再OPEN（Legal/UX 承認後に参加者情報の段階解放）
- RC-PII-001 再OPEN（180日保持・例外保持の法務承認後）

### 現行残存確認ゲート（Iteration 7 時点の履歴）

なし。MVP で採用済みの制約は以下を正本とする。

- テナント分離: 1ユーザー1GCPプロジェクト + 1ユーザー1Cloud SQL。共有基盤・tenant_id・RLS は MVP 対象外。
- DwD allowlist: 空配列は fail-closed。明示 allowlist に含まれ、かつ organizationDomain に一致する対象だけ書き込み可。
- Calendar HUD/API: busy/free、衝突有無、手動確認要否、operation status のみ。参加者名・メール・既存予定名は MVP では返さない。
- approvalToken: DB には SHA-256 ハッシュのみ保存。event_inbox payload にプレーンテキストを保存しない。HUD へは `GET /v1/mail/pending` 等の認証済みカード取得レスポンスで短命 token を返す。
- Calendar/DwD監査: operationId、status、correlationId、非PII skip reason のみ。参加者名・メール・既存予定名・対象ユーザー識別子は記録しない。

## 次回レビュー対象

1. `approvalToken` の平文が `event_inbox.payload`、ログ、DB JSONB に残らないことを OpenAPI / process_flow / DB 派生資料 / test_plan で再検証する。
2. Gmail 承認用 `approvalToken` の DB 保持カラム（hash、cardVersion、expires、consumed marker）が `emails` 正本・カラム一覧・ER図・design 型定義に揃っているか確認する。
3. Calendar PII の HUD/API 禁止が OpenAPI schema と Test-Ref で機械的に検出できるか確認する。
4. DwD allowlist 空配列時の fail-closed 動作を requirements / security / OpenAPI / process_flow / test_plan で維持する。

---

## Iteration 8: 2026-06-04

### 使用エージェント

| 役割 | 対象 | 主な観点 |
|---|---|---|
| 要件・ユースケース整合レビュー | requirements_definition.md, UseCase_List.md, tasks.md, lean-rtm.md | Calendar PII表示、operation結果、SQLite移行表現、CLOSED方針との矛盾 |
| Security / PII / infraレビュー | security_design.md, infra_architecture_design.md, db_design_document.md, process_flow_design.md | Calendar監査PII、SQLite移行バックアップ、FAQ created_by PII、approvalToken保護 |
| API / DB / Test契約レビュー | openapi.yaml, db_design_document.md, db_columns_list_with_relations.md, er_diagram.md, test_plan.md | approvalToken user binding、DwD allowlist欠落時fail-closed、Calendar JSONB保持形状、版数参照 |

### Iteration 8 即時反映

- requirements_definition.md v8.12: REQ-CAL-001/002/003/006 のHUD/API/監査表現を、参加者名・メール・既存予定名・既存予定時刻を出さないMVP方針へ同期。
- design.md v4.9 / process_flow_design.md v2.4: Calendar失敗通知を相関ID・手動補正要中心へ変更し、attendee_ref単位の非PII結果と timeline_events の非PII要約に統一。
- db_design_document.md v1.3 / db_columns_list_with_relations.md v1.1 / er_diagram.md v1.3: `approval_subject_hash` を追加し、approvalToken の承認者 subject hash バインドを実装可能にした。
- db_design_document.md / db_columns_list_with_relations.md: `calendar_proposals.conflict_info` をMVP NULL固定、`slots` と `unavailable_attendees` を非PII JSONB形状に制約。
- openapi.yaml v1.3.7 / test_plan.md v0.5: `dwdAllowlistEmails` 欠落/nullを空配列へ正規化して fail-closed とする契約・検証条件を追加。
- requirements_definition.md / UseCase_List.md / tasks.md / test_plan.md / security_design.md: SQLite移行アーカイブを `.sqlite.enc` 暗号化バックアップ、7日削除、7日以内再試行に統一。
- lean-rtm.md v8.12: REQ-CAL-006 の Statement を非PII結果・非PII監査要約へ更新。
- review_cycle.md: 過去IterationのOPEN表を履歴見出しへ変更し、現行ゲートと混同しないよう明記。

### 確認待ち / 再OPEN候補

以下は重要判断またはデータ保持方針に影響するため、ユーザー確認前に採用しない。

| ID | 内容 | 推奨方針 |
|---|---|---|
| RC-FAQ-PII-001 | `faq_entries.created_by` が登録者OSユーザー名PIIとして残り、90日マスク対象にも含まれていない | MVPでは `created_by` を user subject hash / system identifier に置き換える案を推奨。採用時はDB/security/requirements/test_planを更新 |
| RC-AUTH-002-REOPEN | 社内 Workspace Internal から外部ユーザー公開へ変更する場合 | Google OAuth verification / restricted scope security assessment / User Data Policy 対応を再OPEN |
| RC-CAL-002-REOPEN | Legal/UX承認後に参加者名・メール・既存予定名をHUD/APIへ段階解放する場合 | OpenAPI/DB/test_planを明示的に再OPENし、表示範囲・保持期間・監査ログ除外条件を再設計 |
| RC-PII-001-REOPEN | 180日保持・例外保持を採用する場合 | 法務承認済み文書を添付し、保持例外・バックアップ・移行元データの扱いを再設計 |

### 現行残存確認ゲート（Iteration 8 時点の履歴）

| ID | 状態 | ブロック対象 | 解除証跡 |
|---|---|---|---|
| RC-FAQ-PII-001 | **CLOSED 2026-07-15** | `faq_entries.created_by` のPII保持/マスク範囲 | `created_by_attendee_ref`（backend生成ランダム疑似ID）へ変更。OS username/email/display nameは保存しない |

その他のMVP正本は以下の通り。

- Calendar HUD/API/監査: 参加者名・メール・既存予定名・既存予定時刻・内部eventIdを出さない。
- Calendar DB: attendee_ref / approval_subject_hash など疑似識別子のみ。`conflict_info` は NULL、`slots` は非PII形状。
- DwD allowlist: 空配列・欠落・null はすべて fail-closed。
- approvalToken: 平文は認証済みカード取得レスポンスのみ。DB/event_inbox/log/JSONBには平文を保存しない。
- SQLite移行バックアップ: `.sqlite.enc` 暗号化、7日削除、恒久復元元にしない。

---

## Iteration 9: 2026-06-04

### 使用エージェント

| エージェント | 役割 | 主な観点 |
|---|---|---|
| Averroes | 要件・ユースケース・RTMレビュー | 現行確認ゲート、Calendar補足表現、SQLite移行表現、計画TBDと確認ゲートの分離 |
| Banach | Security / PII / infraレビュー | FAQ created_by PII、DwD fail-closed伝播、approval_subject_hash照合、関連文書版数 |
| Carver | API / DB / Test契約レビュー | Calendar JSONBとOpenAPI差分、unavailableAttendees形状、settings永続化モデル、テスト契約 |

### 精査結果

- `RC-FAQ-PII-001` は FAQ 登録（TASK-010 の FAQ 登録者識別子）に限定した現行 CONFIRM_REQUIRED として維持する。`faq_entries.created_by` を user subject hash / system identifier に変更するか、PII保持例外として承認するかはユーザー確認前に採用しない。auth・health・mail/calendar 承認 HUD 基盤（TASK-004/008/009）はこのゲートでブロックしない。
- Calendar候補の「前後コンテキスト」表現は、既存予定名・既存予定時刻を出すように読めるため、MVPでは非PIIスロット補足（日時・所要時間・busy/free・手動確認要否・期間外ラベル）に再定義する。
- `calendar_proposals.slots[].conflictDetected/manualCheckRequired` は DB 内部専用の非PII補助フィールドとし、OpenAPI `CalendarSlot` / Event payload へそのまま返さない。
- `unavailable_attendees` / `unavailableAttendees` は非PII理由コード文字列の配列に統一し、件数は配列長または集計結果として扱う。
- `settings` はキーごと1行で保存し、API層で集約して `OpenClawSettings` を返す。`dwdAllowlistEmails` 欠落/nullは `[]` に正規化して fail-closed とする。
- OQ-TEST-001 / OQ-UC-003 は確認ゲートではなく、計画TBD / 運用TBDとして扱う。

### Iteration 9 即時反映

- requirements_definition.md v8.13 / design.md v4.10 / UseCase_List.md v1.3 / lean-rtm.md v8.14: Calendar補足表現を非PIIスロット補足へ同期。
- openapi.yaml v1.3.8: `unavailableAttendees` を非PII理由コード配列として明記。
- db_design_document.md v1.4 / db_columns_list_with_relations.md v1.2 / er_diagram.md v1.4: Calendar JSONB内部フィールド境界、非PII理由コード、settings集約契約、DwD欠落/null fail-closedを同期。
- process_flow_design.md v2.5 / security_design.md v1.5: approvalToken検証に `approval_subject_hash` 照合を明記し、DwD allowlist 欠落/null正規化を同期。
- infra_architecture_design.md v1.4 / tasks.md v2.8 / test_plan.md v0.6: 関連文書版数、計画TBD表現、`RC-FAQ-PII-001` の確認待ち追跡を同期。

### 現行残存確認ゲート

### Iteration 10 横断整合補完（2026-06-07）

- openapi.yaml v1.3.9: auth bootstrap、Calendar proposal取得、settings backend/admin属性、Scheduler/Tasks OIDC audience（Cloud Run service URL）を正本化。auth bootstrap 前提は 2026-06-09 の openapi.yaml v1.4.0 で Gateway OAuth handoff / backend confidential exchange に superseded。
- requirements_definition.md / design.md / process_flow_design.md / security_design.md: HUDユーザーID token `aud`=OAuth client ID と Scheduler/Tasks OIDC `aud`=Cloud Run service URL を分離。2026-06-09 更新で `openclaw-api` direct `roles/run.invoker` は gateway SA / Scheduler SA / Tasks SA のみに限定。
- db_design_document.md / db_columns_list_with_relations.md / er_diagram.md / test_plan.md: `timeline_events.detail` を operationId/status/correlationId/非PII skip reason/errorCode/exceptionClass の allowlist に統一し、選択スロットは `calendar_operations` 側に限定。
- tasks.md v2.9 / test_plan.md v0.7 / lean-rtm.md v8.15: `RC-FAQ-PII-001` を FAQ 登録（TASK-010 の FAQ 登録者識別子）限定ゲートとして明記し、auth・health・mail/calendar 承認 HUD 基盤（TASK-004/008/009）をブロックしないことを同期。

| ID | 状態 | ブロック対象 | 解除証跡 |
|---|---|---|---|
| RC-FAQ-PII-001 | **CLOSED 2026-07-15** | FAQ登録者識別子 | `created_by_attendee_ref`（backend生成ランダム疑似ID）を採用 |

## 次回レビュー対象

1. DB正本v2.1からmigration DDLを実装し、旧補助snapshotを再生成する。
2. OpenAPI v1.8.0のsettings/scheduling/card variantがFront/Terraform contractへ与える影響をレビューする。
3. Gmail/Calendar crash-point matrixとOAuth provisioning補償を実コードで検証する。
4. AI/RAG adversarial suiteとresource authorization matrixをrelease gateとして実行する。

### Iteration 11 D-37〜D-46 remediation（2026-07-15）

- OAuth bootstrap、strict loopback、Admin/SA分離、resource authorization、Calendar scope/再検証、claim token lifecycle、AI failure schema、Gmail ledger、Calendar outbox、History checkpoint、AI/RAG境界、仮名化data、deterministic schedulingを正本へ反映した。
- D-43はD-08/C-10の一律`maxAttempts=1`を、D-44はD-23の逐次polling/固定lockを上書きする。
- RC-FAQ-PII-001を疑似ID方式でCLOSEDとした。現行の確認必須ゲートは0件。artifact自体はmigration/codeと実行テスト前のためDRAFTを維持する。
