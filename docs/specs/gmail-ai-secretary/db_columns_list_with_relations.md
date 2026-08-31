# DBカラム一覧（リレーション付き）: OpenClaw AI秘書

## 現在値に関する注意（2026-07-16）

本書は旧論理設計の比較用snapshotであり、現行24テーブルの完全なカラム辞書ではない。実装判断には[`001_initial.sql`](../../../migrations/001_initial.sql)と[`002_remediation.sql`](../../../migrations/002_remediation.sql)を使用する。現行テーブル一覧は[現行実装ベースライン](../../implementation/current-implementation.md)を参照する。特に本書の`settings`は現行DDLの`settings_revisions`と一致せず、追加6テーブルも詳細一覧に含まれていない。

作成日: 2026-06-03 | バージョン: 1.6 | 更新日: 2026-07-15 (D-37〜D-46 差分を正本へ移管) | ステータス: DEPRECATED SNAPSHOT
依拠文書: db_design_document.md v2.1（正本）

---

## 文書概要

> **旧12テーブルの参考 snapshot**: 本書だけでDDLを作成してはいけません。D-37〜D-46で追加された`mailbox_poll_state`、`mail_send_operations`、`outbox_events`、`faq_candidates`、暗号化draft/plan、owner/BU境界は`db_design_document.md v2.1`だけを参照してください。migration作成後はDDLから本書を再生成します（D-30）。

本書は旧12テーブル時点のカラムsnapshotであり、履歴比較にのみ使用する。実装判断はDB正本、実装後はmigration DDLを使用する。

---

## 目的

- migration DDL 実装時のカラム定義リファレンスを提供する
- 外部キー削除制約（CASCADE / RESTRICT / SET NULL）を一覧で確認可能にする
- PII 保有カラムを明示し、retention job 設計・セキュリティレビューを支援する
- インデックス種別・パーシャル条件を明記し、パフォーマンス設計の根拠を示す

---

## 対象範囲

本書は旧12テーブルのみを対象とする。現行16テーブルと全制約は`db_design_document.md v2.1`を参照する。

---

## 前提

| # | 前提条件 |
|---|---|
| P-01 | Cloud SQL PostgreSQL（バージョン 15 以上）と pgvector 拡張が有効化されていること |
| P-02 | Cloud Run と Cloud SQL は同一 GCP リージョンに配置されること（REQ-STORE-001）|
| P-03 | 1組織共有バックエンドで複数user/BUを扱い、owner_attendee_ref/business_unit_refでresource分離する |
| P-04 | HUD（Electron）は Cloud SQL に直接接続しない（REQ-DATA-001）|
| P-05 | 全文字列は UTF-8 で格納する |
| P-06 | タイムスタンプはすべて `TIMESTAMPTZ`（UTC 保存）とする |

---

## テーブル一覧サマリー

| テーブル名 | 区分 | PK 型 | FK 数 | pgvector | 用途概要 |
|---|---|---|---|---|---|
| `users` | 現在値 | UUID | 0 | なし | **[NEW]** マルチユーザー認証 allowlist。google_subject_hash ↔ attendee_ref 対応管理 |
| `emails` | 現在値 | UUID | 0（被参照のみ） | なし | 受信メール本文・分析結果・対応ステータスの正本 |
| `timeline_events` | 追記専用 | UUID | 1 | なし | 全操作監査ログ（UPDATE/DELETE 禁止） |
| `event_inbox` | イベントキュー | UUID | 1 | なし | HUD polling 向けイベント本体 |
| `event_inbox_recipients` | イベントキュー | UUID+TEXT | 1 | なし | event_inbox の宛先ユーザーとユーザー単位 ACK 状態 |
| `calendar_proposals` | 現在値 | UUID | 1 | なし | スケジュール調整案（候補スロット・集約承認状態） |
| `proposal_approvals` | 現在値 | UUID | 1 | なし | **[NEW]** 参加者ごとの承認状態・approvalToken を管理（C-13/D-19） |
| `calendar_operations` | 現在値 | TEXT | 2 | なし | カレンダー更新の冪等状態管理 |
| `calendar_operation_results` | 現在値 | UUID | 1 | なし | 参加者別カレンダー更新結果 |
| `faq_entries` | 現在値 | UUID | 1 | vector(768) | FAQナレッジ（pgvector埋め込みあり） |
| `sent_reply_embeddings` | 現在値 | UUID | 1 | vector(768) | 送信済み返信履歴（pgvector埋め込みあり、匿名化済み） |
| `settings` | 現在値 | UUID | 0 | なし | OpenClaw 設定値 |

---

## テーブル別詳細

---

#### テーブル名: `users`

**用途・区分**: 現在値 — マルチユーザーバックエンドの認証 allowlist。Google ID token の `sub` を SHA-256 化した `google_subject_hash` と `attendee_ref` の対応を管理する。`ALLOWED_SUBJECT` 環境変数に代わり、このテーブルが認証の唯一の allowlist となる（C-15 / D-17）。BU ユーザーは管理者が `POST /internal/admin/users` で事前登録し、個人ユーザーは HUD 初回 OAuth 同意フロー完了時に自動登録される（D-25 / BE-REQ-028）。

**カラム一覧**

| カラム名 | 型 | NULL | DEFAULT | 制約/備考 |
|---|---|---|---|---|
| `id` | UUID | NOT NULL | `gen_random_uuid()` | PK |
| `google_subject_hash` | TEXT | NOT NULL | — | UNIQUE NOT NULL。sha256(Google ID token `sub`)。認証 allowlist の主キー的役割 |
| `attendee_ref` | TEXT | NOT NULL | — | UNIQUE NOT NULL。backend生成のランダムUUID。氏名/title/emailから導出しない |
| `workspace_access_type` | TEXT | NOT NULL | — | `personal_oauth`（個人 Workspace アカウント）/ `business_unit_dwd`（事業部共有アカウント経由）|
| `last_seen_at` | TIMESTAMPTZ | NULL | — | 最終 HUD アクセス日時 |
| `created_at` | TIMESTAMPTZ | NOT NULL | `now()` | |
| `updated_at` | TIMESTAMPTZ | NOT NULL | `now()` | |

**主キー**: `id`（UUID）

**外部キー**

なし（他テーブルから論理参照されるが、物理 FK は持たない）

**インデックス**

| インデックス名 | 対象カラム | 種別 | パーシャル条件 |
|---|---|---|---|
| `idx_users_google_subject_hash` | `google_subject_hash` | UNIQUE B-tree | なし |
| `idx_users_attendee_ref` | `attendee_ref` | UNIQUE B-tree | なし |

**制約**
- `users_workspace_access_type_check`: `workspace_access_type IN ('personal_oauth', 'business_unit_dwd')`

**特記事項**: 通常APIはactive userのみ許可する。個人OAuthは`oauth_provisioning`作成→Secret保存→activeの順に遷移する。attendee_refはランダムUUIDであり、perUserSaltはmailbox_ref生成だけに使用する。

---

#### テーブル名: `emails`

**用途・区分**: 現在値 — 受信メールの本文・分析結果・対応ステータスを管理する正本テーブル

**カラム一覧**

| カラム名 | 型 | NULL | DEFAULT | 制約/備考 |
|---|---|---|---|---|
| `id` | UUID | NOT NULL | `gen_random_uuid()` | PK |
| `gmail_id` | TEXT | NOT NULL | — | Gmail message ID。`(mailbox_ref,gmail_id)`がUNIQUE |
| `thread_id` | TEXT | NOT NULL | — | Gmail thread ID |
| `mailbox_ref` | TEXT | NOT NULL | — | 受信 mailbox の疑似識別子。sha256(gmailAccount + perUserSalt)。per-mailbox visibility 制御に使用。生 Gmail アドレスは保存しない（D-22 / C-17） |
| `from_address` | TEXT | NOT NULL | — | 差出人メールアドレス [PII] |
| `subject` | TEXT | NOT NULL | — | 件名 |
| `body_preview` | TEXT | NULL | — | [PII] 本文先頭 500 文字 |
| `received_at` | TIMESTAMPTZ | NOT NULL | — | 受信日時 |
| `status` | TEXT | NOT NULL | `'未対応'` | `未対応` / `pending_calendar` / `pending_reply_approval` / `対応中` / `回答済み` / `解決済み` / `保留`（CHECK 制約あり） |
| `category` | TEXT | NULL | — | AI 判定カテゴリ（7種） |
| `urgency` | TEXT | NULL | — | `高` / `中` / `低` / `なし`（CHECK 制約あり） |
| `summary` | TEXT | NULL | — | 3行要約 |
| `actions` | TEXT | NULL | — | 必要アクション |
| `sender_intent` | TEXT | NULL | — | 送信者意図（40文字以内） |
| `reply_required` | BOOLEAN | NOT NULL | `true` | 返答要否 |
| `is_schedule` | BOOLEAN | NOT NULL | `false` | スケジュール関連フラグ |
| `scheduling_type` | TEXT | NULL | — | `datetime_specified` / `open_ended` |
| `proposed_datetimes` | JSONB | NULL | — | 提案日時リスト（datetime_specified 時のみ） |
| `participants` | JSONB | NULL | — | 参加者リスト [PII] |
| `draft_id` | TEXT | NULL | — | Gmail 下書き ID |
| `approval_token_hash` | TEXT | NULL | — | Gmail承認操作許可トークンの SHA-256 ハッシュ。平文は DB・event_inbox・ログに保存しない |
| `approval_subject_hash` | TEXT | NULL | — | 承認者 Google subject の SHA-256 ハッシュ。別ユーザー token 利用を拒否するための疑似識別子 |
| `card_version` | INTEGER | NOT NULL | `1` | Gmail承認カードの stale 検出用バージョン |
| `token_expires_at` | TIMESTAMPTZ | NULL | — | Gmail承認トークン有効期限 |
| `approval_token_consumed_at` | TIMESTAMPTZ | NULL | — | 承認/拒否でトークンを単回使用済みにした時刻 |
| `claimer_attendee_ref` | TEXT | NULL | — | BU 共有メールのクレーム保持者の attendee_ref。NULL = 未着手。クレーム取得時に設定し、解除・移譲・2h タイムアウト時にリセット。ただし `pending_calendar` 中は自動リセットしない（D-26/D-27） |
| `claimed_at` | TIMESTAMPTZ | NULL | — | クレーム取得日時。`claimed_at < now() - interval '2 hours'` でレイジー評価タイムアウト。ただし `pending_calendar` 中は対象外（D-26） |
| `hud_display_ready` | BOOLEAN | NOT NULL | `false` | HUD polling 対象フラグ |
| `pii_masked_at` | TIMESTAMPTZ | NULL | — | retention job による PII マスク完了時刻 |
| `created_at` | TIMESTAMPTZ | NOT NULL | `now()` | |
| `updated_at` | TIMESTAMPTZ | NOT NULL | `now()` | |

**主キー**: `id`（UUID）

**外部キー**

なし（他テーブルから参照される被参照テーブル）

**インデックス**

| インデックス名 | 対象カラム | 種別 | パーシャル条件 |
|---|---|---|---|
| `idx_emails_mailbox_gmail_id` | `mailbox_ref, gmail_id` | UNIQUE B-tree | なし |
| `idx_emails_status` | `status` | B-tree | `WHERE status IN ('未対応', '対応中', 'pending_calendar', 'pending_reply_approval')` |
| `idx_emails_hud_display_ready` | `hud_display_ready` | B-tree | `WHERE hud_display_ready = true` |
| `idx_emails_received_at` | `received_at` | B-tree（降順） | なし |
| `idx_emails_mailbox_ref` | `mailbox_ref` | B-tree | なし |
| `idx_emails_claimer_attendee_ref` | `claimer_attendee_ref` | B-tree | なし |

**制約**
- `emails_status_check`: `status IN ('未対応', 'pending_calendar', 'pending_reply_approval', '対応中', '回答済み', '解決済み', '保留')`
- `emails_urgency_check`: `urgency IN ('高', '中', '低', 'なし')`

**特記事項**: `body_preview` および `from_address` は retention job による PII マスク対象カラム（`pii_masked_at` 記録後クリア）。`claimer_attendee_ref` は BU 共有メールのみに設定し、個人 mailbox のメールには使用しない。`pending_calendar` 中は Calendar 参加者承認が2時間を超え得るため、クレームの自動タイムアウト解除を行わない。`mailbox_ref` は per-mailbox visibility フィルタリングに使用する。

---

#### テーブル名: `timeline_events`

**用途・区分**: 追記専用 — メール受信から最終処置までの全操作を記録する監査テーブル。PostgreSQL トリガーで UPDATE・DELETE を禁止する

**カラム一覧**

| カラム名 | 型 | NULL | DEFAULT | 制約/備考 |
|---|---|---|---|---|
| `id` | UUID | NOT NULL | `gen_random_uuid()` | PK |
| `mail_id` | UUID | NULL | — | FK(emails.id)。OpenClaw停止等メール未特定の critical では NULL |
| `event_type` | TEXT | NOT NULL | — | イベント種別（列挙値は下記参照） |
| `operator` | TEXT | NULL | — | MVP は NULL またはシステム識別子（例: `hud-system`）のみ。OS ユーザー名などPIIは保存しない（OQ-DB-003 CLOSED） |
| `detail` | TEXT | NULL | — | 非PII allowlist の追加情報（operationId・status・correlationId・skipReason・errorCode・exceptionClass 等）。raw エラーメッセージ・stack trace・token・本文/件名/氏名/メールアドレスは保存しない |
| `correlation_id` | UUID | NULL | — | エラー相関 ID |
| `timestamp` | TIMESTAMPTZ | NOT NULL | `now()` | |

`event_type` 列挙値: `received` / `analyzed` / `hud_shown` / `approved` / `rejected` / `sent` / `mail_claimed` / `mail_unclaimed` / `mail_transferred` / `cal_participant_approved` / `cal_participant_rejected` / `cal_all_approved` / `cal_any_rejected` / `cal_selection_conflict` / `cal_succeeded` / `cal_partial_failed` / `cal_replanned` / `cal_candidate_limited` / `cal_superseded` / `faq_suggested` / `faq_registered` / `draft_saved` / `draft_deleted` / `error_minor` / `error_critical`

**主キー**: `id`（UUID）

**外部キー**

| カラム名 | 参照先テーブル.カラム | ON DELETE | 備考 |
|---|---|---|---|
| `mail_id` | `emails.id` | SET NULL | 監査ログは追記専用。メール削除後も監査記録を保持。NULL 許容カラムのため SET NULL で整合性を維持 |

**インデックス**

| インデックス名 | 対象カラム | 種別 | パーシャル条件 |
|---|---|---|---|
| `idx_timeline_events_mail_id` | `mail_id` | B-tree | なし |
| `idx_timeline_events_timestamp` | `timestamp` | B-tree | なし |

**特記事項**: PostgreSQL トリガー `trg_timeline_no_update`・`trg_timeline_no_delete` により UPDATE・DELETE を禁止。MVPでは `operator` / `detail` にPIIを保存しない。

---

#### テーブル名: `event_inbox`

**用途・区分**: イベントキュー — HUD polling（GET /v1/events）向けの非同期通知本体。宛先と ACK 状態は `event_inbox_recipients` がユーザー単位で管理する（D-22）

**カラム一覧**

| カラム名 | 型 | NULL | DEFAULT | 制約/備考 |
|---|---|---|---|---|
| `event_id` | UUID | NOT NULL | `gen_random_uuid()` | PK |
| `type` | TEXT | NOT NULL | — | イベント種別（列挙値は下記参照） |
| `mail_id` | UUID | NULL | — | FK(emails.id)。関連メール ID |
| `operation_id` | TEXT | NULL | — | 関連 Calendar operation ID（sha256 由来の決定的 ID） |
| `payload` | JSONB | NOT NULL | — | OpenAPI Event.payload に対応する型付きデータ |
| `created_at` | TIMESTAMPTZ | NOT NULL | `now()` | |

`type` 列挙値: `mail_approval_ready` / `mail_reply_ready` / `mail_claimed` / `mail_unclaimed` / `mail_transferred` / `calendar_proposals_ready` / `calendar_alternatives_ready` / `faq_candidate` / `calendar_operation_succeeded` / `calendar_operation_failed` / `critical_error` / `status_changed`

**主キー**: `event_id`（UUID）

**外部キー**

| カラム名 | 参照先テーブル.カラム | ON DELETE | 備考 |
|---|---|---|---|
| `mail_id` | `emails.id` | SET NULL | メール削除後も ACK 前イベントのコンテキストを保持し、HUD への通知処理を継続するため |

**インデックス**

| インデックス名 | 対象カラム | 種別 | パーシャル条件 |
|---|---|---|---|
| `idx_event_inbox_created_at_event_id` | `created_at`, `event_id` | B-tree | なし |
| `idx_event_inbox_mail_id` | `mail_id` | B-tree | なし |

**特記事項**: `event_inbox` は通知本文のみを持つ。宛先ユーザーと ACK 状態は `event_inbox_recipients` を参照する。全 recipient 行が ACK 済みで、最後の `acked_at` から7日経過した event を定期削除する。

---

#### テーブル名: `event_inbox_recipients`

**用途・区分**: イベントキュー — `event_inbox` の宛先とユーザー単位 ACK 状態を管理する。BU 共有 mailbox の通知は BU 全 members 分の recipient 行を作成し、個人 mailbox の通知は本人1行だけを作成する。

**カラム一覧**

| カラム名 | 型 | NULL | DEFAULT | 制約/備考 |
|---|---|---|---|---|
| `event_id` | UUID | NOT NULL | — | PK, FK(event_inbox.event_id)。対象イベント |
| `target_user_ref` | TEXT | NOT NULL | — | PK。このイベントを受け取る attendee_ref |
| `acked_at` | TIMESTAMPTZ | NULL | — | このユーザーが ACK した時刻。NULL = 未ACK |
| `created_at` | TIMESTAMPTZ | NOT NULL | `now()` | |

**主キー**: (`event_id`, `target_user_ref`)

**外部キー**

| カラム名 | 参照先テーブル.カラム | ON DELETE | 備考 |
|---|---|---|---|
| `event_id` | `event_inbox.event_id` | CASCADE | 通知本体削除時に宛先/ACK状態も削除するため |

**インデックス**

| インデックス名 | 対象カラム | 種別 | パーシャル条件 |
|---|---|---|---|
| `idx_event_inbox_recipients_unacked_user` | `target_user_ref`, `event_id` | B-tree | `WHERE acked_at IS NULL` |
| `idx_event_inbox_recipients_event_id` | `event_id` | B-tree | なし |

**特記事項**: `GET /v1/events` は `target_user_ref = caller_attendee_ref AND acked_at IS NULL` の recipient 行を `event_inbox` と JOIN して返す。`POST /v1/events/{eventId}/ack` は caller の recipient 行だけを `acked_at = COALESCE(acked_at, now())` で冪等更新する。caller の recipient 行がない場合は 403。

---

#### テーブル名: `calendar_proposals`

**用途・区分**: 現在値 — スケジュール調整案（候補スロット・集約承認状態）の正本。per-participant approvalToken は `proposal_approvals` テーブルで管理する（C-13）

**カラム一覧**

| カラム名 | 型 | NULL | DEFAULT | 制約/備考 |
|---|---|---|---|---|
| `proposal_id` | UUID | NOT NULL | `gen_random_uuid()` | PK |
| `parent_proposal_id` | UUID | NULL | — | FK(calendar_proposals.proposal_id)。拒否後代替案の元 proposal |
| `revision` | INTEGER | NOT NULL | `1` | 同一メール内の提案世代。1以上 |
| `mail_id` | UUID | NOT NULL | — | FK(emails.id) |
| `scheduling_type` | TEXT | NOT NULL | — | `datetime_specified` / `open_ended` |
| `proposed_datetimes` | JSONB | NULL | — | 提案日時リスト（datetime_specified のみ） |
| `conflict_info` | JSONB | NULL | — | MVPでは NULL 固定。Legal/UX 承認後の将来拡張予約 |
| `slots` | JSONB | NOT NULL | — | 候補スロット（0〜3件）。slotId、日時、rank、scoreReasonCodes、期間内/期間外ラベル、全参加者の前後予定タイトル・マスク済み本文・参加者表示名を保存可。メールアドレス・Google event id・calendar id・会議URL・token は保存しない |
| `context` | TEXT | NULL | — | 生成コンテキスト情報。固定コード/理由のみ |
| `unavailable_attendees` | JSONB | NULL | — | 空配列、非PII理由コード、または管理外参加者状態コード。メールアドレスは保存しない |
| `rejection_reason_code` | TEXT | NULL | — | proposal 全体の代表拒否理由コード。参加者別詳細は proposal_approvals に保存 |
| `candidate_count` | INTEGER | NOT NULL | `0` | 生成済み候補数。0から3の範囲 |
| `candidate_limit_reason` | TEXT | NULL | — | 3候補未満の理由コード |
| `alternative_suggestions` | JSONB | NULL | — | 期間拡張、参加者調整、手動確認などの非PII代替案コード配列 |
| `manual_confirmation_prompt` | JSONB | NULL | — | 管理外必須参加者がいる場合に HUD へ返す手動確認用テキスト。メールアドレス・Google event id・calendar id・会議URL・token は保存しない |
| `aggregate_approval_status` | TEXT | NOT NULL | `'pending_all'` | 全参加者の承認集約状態。`pending_all` / `all_approved` / `any_rejected` / `selection_conflict`（C-13/D-19） |
| `status` | TEXT | NOT NULL | `'active'` | `active` / `manual_review_required` / `execution_pending` / `executed` / `superseded` / `cancelled` |
| `created_at` | TIMESTAMPTZ | NOT NULL | `now()` | |
| `updated_at` | TIMESTAMPTZ | NOT NULL | `now()` | |

**主キー**: `proposal_id`（UUID）

**外部キー**

| カラム名 | 参照先テーブル.カラム | ON DELETE | 備考 |
|---|---|---|---|
| `mail_id` | `emails.id` | CASCADE | 調整案はメールのライフサイクルに従属するため、メール削除時に関連する調整案も削除する |
| `parent_proposal_id` | `calendar_proposals.proposal_id` | SET NULL | 親 proposal が削除された場合も子 proposal の監査状態を保持するため |

**インデックス**

| インデックス名 | 対象カラム | 種別 | パーシャル条件 |
|---|---|---|---|
| `idx_calendar_proposals_mail_id` | `mail_id` | B-tree | なし |
| `idx_calendar_proposals_parent_proposal_id` | `parent_proposal_id` | B-tree | なし |
| `idx_calendar_proposals_status` | `status` | B-tree | `WHERE status IN ('active', 'manual_review_required', 'execution_pending')` |

**制約**
- `calendar_proposals_status_check`: `status IN ('active', 'manual_review_required', 'execution_pending', 'executed', 'superseded', 'cancelled')`
- `calendar_proposals_aggregate_approval_status_check`: `aggregate_approval_status IN ('pending_all', 'all_approved', 'any_rejected', 'selection_conflict')`
- `calendar_proposals_revision_check`: `revision >= 1`
- `calendar_proposals_candidate_count_check`: `candidate_count BETWEEN 0 AND 3`

**特記事項**: per-participant approvalToken は `proposal_approvals` テーブルで管理し、`calendar_proposals` に `approval_token` / `approval_subject_hash` カラムは持たない（C-13）。`aggregate_approval_status = all_approved` への遷移は、全参加者が approved かつ同一 `selected_slot_id` を選択した場合のみ許可し、その時だけ Cloud Tasks への operation enqueue を行う。`manual_review_required` proposal では管理外参加者の `proposal_approvals` 行を作成せず、`manual_confirmation_prompt` の確認対象として保持するため、管理内参加者の承認が揃っても Cloud Tasks へ enqueue しない。

---

#### テーブル名: `proposal_approvals`

**用途・区分**: 現在値 — スケジュール調整案に対する参加者ごとの承認状態・approvalToken を管理する。`calendar_proposals` の単一承認トークン設計をマルチユーザー対応に置き換える（C-13 / D-19）

**カラム一覧**

| カラム名 | 型 | NULL | DEFAULT | 制約/備考 |
|---|---|---|---|---|
| `id` | UUID | NOT NULL | `gen_random_uuid()` | PK |
| `proposal_id` | UUID | NOT NULL | — | FK(calendar_proposals.proposal_id) |
| `attendee_ref` | TEXT | NOT NULL | — | users登録時のランダムUUID疑似識別子。氏名/title/emailから導出しない |
| `google_subject_hash` | TEXT | NOT NULL | — | 参加者 Google subject の SHA-256 ハッシュ。承認操作者の確認に使用 |
| `status` | TEXT | NOT NULL | `'pending'` | `pending`（未回答）/ `approved`（承認済み）/ `rejected`（拒否済み）（CHECK 制約あり） |
| `approval_token_hash` | TEXT | NULL | — | SHA-256(plaintext_token)。平文は GET /v1/calendar/proposals/{id} レスポンスでのみ返す |
| `card_version` | INTEGER | NOT NULL | `1` | stale card 検出用バージョン |
| `token_expires_at` | TIMESTAMPTZ | NULL | — | approvalToken 有効期限（生成時から 72h） |
| `rejection_reason_code` | TEXT | NULL | — | 拒否理由の非 PII コード |
| `rejection_reason_detail` | TEXT | NULL | — | HUD 拒否フォームのマスク済み理由メモ。event_inbox / log には保存しない |
| `rejected_slot_ids` | JSONB | NULL | — | 拒否者が避けたい候補 slotId 配列（最大3件） |
| `preferred_windows` | JSONB | NULL | — | 拒否者が入力した都合のよい時間帯（最大3件、start/endのみ） |
| `selected_slot_id` | TEXT | NULL | — | 承認時に選択した候補 slotId。status=approved の場合は必須 |
| `selected_slot_start` | TIMESTAMPTZ | NULL | — | 承認時点で選択した slotStart のスナップショット |
| `selected_slot_end` | TIMESTAMPTZ | NULL | — | 承認時点で選択した slotEnd のスナップショット |
| `created_at` | TIMESTAMPTZ | NOT NULL | `now()` | |
| `updated_at` | TIMESTAMPTZ | NOT NULL | `now()` | |

**主キー**: `id`（UUID）

**外部キー**

| カラム名 | 参照先テーブル.カラム | ON DELETE | 備考 |
|---|---|---|---|
| `proposal_id` | `calendar_proposals.proposal_id` | CASCADE | proposal 削除時に関連する承認行も削除する |

**インデックス**

| インデックス名 | 対象カラム | 種別 | パーシャル条件 |
|---|---|---|---|
| `idx_proposal_approvals_proposal_id` | `proposal_id` | B-tree | なし |
| `idx_proposal_approvals_proposal_attendee` | `proposal_id`, `attendee_ref` | UNIQUE B-tree | なし |

**制約**
- `UNIQUE (proposal_id, attendee_ref)` — 同一参加者の二重登録防止
- `proposal_approvals_status_check`: `status IN ('pending', 'approved', 'rejected')`
- `proposal_approvals_selected_slot_check`: `status != 'approved' OR (selected_slot_id IS NOT NULL AND selected_slot_start IS NOT NULL AND selected_slot_end IS NOT NULL)`
- 承認/拒否時は `proposal_id` + `attendee_ref` + `google_subject_hash` + `card_version` + `token_expires_at` + `approval_token_hash` を検証する
- 他参加者（google_subject_hash 不一致）による操作は 403 とする

**特記事項**: 通常 proposal 生成時に参加者全員分をINSERTする。代替案生成時は旧行を更新せず、新revisionのproposal_idへ新規INSERTする（append-only・D-32）。旧選択／拒否入力は監査と再提示防止のため保持する。selected_slot_idが割れた場合はselection_conflictとし書き込まない。

---

#### テーブル名: `calendar_operations`

**用途・区分**: 現在値 — HUD 承認後の Calendar 更新操作の冪等状態管理。`operation_id` で重複実行を防ぐ

**カラム一覧**

| カラム名 | 型 | NULL | DEFAULT | 制約/備考 |
|---|---|---|---|---|
| `operation_id` | TEXT | NOT NULL | — | PK。sha256(mailId+proposalId+selectedSlotId+slotStart+slotEnd+attendeeRefs+approvalSubjectHash) 由来の決定的 ID |
| `proposal_id` | UUID | NOT NULL | — | FK(calendar_proposals.proposal_id) |
| `mail_id` | UUID | NOT NULL | — | FK(emails.id) |
| `approver_user_id` | TEXT | NOT NULL | — | 承認者識別子。MVPでは疑似識別子のみを保存し、氏名・メールなどPIIは保存しない |
| `selected_slot_start` | TIMESTAMPTZ | NOT NULL | — | 承認されたスロット開始 |
| `selected_slot_end` | TIMESTAMPTZ | NOT NULL | — | 承認されたスロット終了 |
| `status` | TEXT | NOT NULL | `'in_progress'` | `in_progress` / `succeeded` / `failed`（CHECK 制約あり） |
| `manual_remediation_required` | BOOLEAN | NOT NULL | `false` | 手動補正要フラグ |
| `correlation_id` | UUID | NULL | — | エラー相関 ID |
| `created_at` | TIMESTAMPTZ | NOT NULL | `now()` | |
| `updated_at` | TIMESTAMPTZ | NOT NULL | `now()` | |

**主キー**: `operation_id`（TEXT）

**外部キー**

| カラム名 | 参照先テーブル.カラム | ON DELETE | 備考 |
|---|---|---|---|
| `mail_id` | `emails.id` | RESTRICT | 操作完了前のメール削除を禁止し、冪等管理の整合性を保護するため |
| `proposal_id` | `calendar_proposals.proposal_id` | RESTRICT | カレンダー操作が参照している提案の削除を禁止し、冪等性管理データの整合性を保護する |

**インデックス**

| インデックス名 | 対象カラム | 種別 | パーシャル条件 |
|---|---|---|---|
| `idx_calendar_operations_proposal_id` | `proposal_id` | B-tree | なし |
| `idx_calendar_operations_status` | `status` | B-tree | なし |

**制約**
- `calendar_operations_status_check`: `status IN ('in_progress', 'succeeded', 'failed')`
- `operation_id` は UNIQUE（重複 INSERT を `ON CONFLICT DO NOTHING` または UPSERT で防ぐ）

---

#### テーブル名: `calendar_operation_results`

**用途・区分**: 現在値 — Calendar 更新操作の attendee_ref 単位の非PII結果を保存。HUD に内部 `event_id` は渡さない

**カラム一覧**

| カラム名 | 型 | NULL | DEFAULT | 制約/備考 |
|---|---|---|---|---|
| `id` | UUID | NOT NULL | `gen_random_uuid()` | PK |
| `operation_id` | TEXT | NOT NULL | — | FK(calendar_operations.operation_id) |
| `attendee_ref` | TEXT | NOT NULL | — | 参加者の疑似識別子（例: SHA-256(email + per-user salt)）。メールアドレス・表示名は保存しない |
| `status` | TEXT | NOT NULL | — | `succeeded` / `failed` / `skipped`（CHECK 制約あり） |
| `event_id` | TEXT | NULL | — | Google Calendar 内部 eventId（HUD には渡さない） |
| `error_code` | TEXT | NULL | — | API エラーコード |
| `api_correlation_id` | TEXT | NULL | — | Google API 相関 ID |
| `updated_at` | TIMESTAMPTZ | NOT NULL | `now()` | |

**主キー**: `id`（UUID）

**外部キー**

| カラム名 | 参照先テーブル.カラム | ON DELETE | 備考 |
|---|---|---|---|
| `operation_id` | `calendar_operations.operation_id` | RESTRICT | 操作の結果が残存する状態で操作レコードを削除することを禁止するため |

**インデックス**

| インデックス名 | 対象カラム | 種別 | パーシャル条件 |
|---|---|---|---|
| `idx_calendar_operation_results_operation_id` | `operation_id` | B-tree | なし |

**制約**
- `(operation_id, attendee_ref)` に UNIQUE 制約（UPSERT により冪等更新）
- `calendar_operation_results_status_check`: `status IN ('succeeded', 'failed', 'skipped')`

---

#### テーブル名: `faq_entries`

**用途・区分**: 現在値 — HUD から登録した FAQ ナレッジ。pgvector 埋め込みで意味的検索を実現する。PII 除去確認済みコンテンツのみ保存

**カラム一覧**

| カラム名 | 型 | NULL | DEFAULT | 制約/備考 |
|---|---|---|---|---|
| `id` | UUID | NOT NULL | `gen_random_uuid()` | PK |
| `question` | TEXT | NOT NULL | — | FAQ 質問文（PII 除去済み） |
| `answer` | TEXT | NOT NULL | — | FAQ 回答文（PII 除去済み） |
| `category` | TEXT | NULL | — | FAQ 分類 |
| `source_mail_id` | UUID | NULL | — | FK(emails.id)。元メール ID（任意） |
| `pii_reviewed` | BOOLEAN | NOT NULL | `false` | HUD での PII 除去確認済みフラグ |
| `embedding` | vector(768) | NULL | — | pgvector 埋め込みベクトル（Gemini text-embedding-004、768次元） |
| `is_active` | BOOLEAN | NOT NULL | `true` | FAQ 無効化（soft delete）フラグ |
| `disabled_at` | TIMESTAMPTZ | NULL | — | 無効化日時 |
| `created_by_attendee_ref` | TEXT | NOT NULL | — | backend生成ランダム疑似ID。RC-FAQ-PII-001 CLOSED |
| `created_at` | TIMESTAMPTZ | NOT NULL | `now()` | |
| `updated_at` | TIMESTAMPTZ | NOT NULL | `now()` | |

**主キー**: `id`（UUID）

**外部キー**

| カラム名 | 参照先テーブル.カラム | ON DELETE | 備考 |
|---|---|---|---|
| `source_mail_id` | `emails.id` | SET NULL | FAQ は独立したナレッジとして保持するため、ソースメール削除後も FAQ レコードは有効のまま維持する |

**インデックス**

| インデックス名 | 対象カラム | 種別 | パーシャル条件 |
|---|---|---|---|
| `idx_faq_entries_embedding` | `embedding` | HNSW（`vector_cosine_ops`, `m=16`, `ef_construction=64`） | なし |
| `idx_faq_entries_category` | `category` | B-tree | なし |
| `idx_faq_entries_active` | `is_active` | B-tree | `WHERE is_active = true` |

**特記事項**: `pii_reviewed = false` は拒否する。soft deleteは`is_active=false` + `disabled_at`。登録者は`created_by_attendee_ref`だけを保存し、OS username/email/display nameは保存しない。

---

#### テーブル名: `sent_reply_embeddings`

**用途・区分**: 現在値 — 送信済み返信履歴を匿名化したうえで pgvector 埋め込みし、RAG コンテキストとして活用する

**カラム一覧**

| カラム名 | 型 | NULL | DEFAULT | 制約/備考 |
|---|---|---|---|---|
| `id` | UUID | NOT NULL | `gen_random_uuid()` | PK |
| `mail_id` | UUID | NOT NULL | — | FK(emails.id)。元メール ID |
| `anonymized_text` | TEXT | NULL | — | `[REDACTED_EMAIL]` / `[PERSON_N]` 置換済みテキスト。90日後にクリアされるため NULL 許容 |
| `embedding` | vector(768) | NULL | — | pgvector 埋め込みベクトル（Gemini text-embedding-004、768次元） |
| `pii_masked_at` | TIMESTAMPTZ | NULL | — | retention job による匿名化テキストクリア完了時刻 |
| `created_at` | TIMESTAMPTZ | NOT NULL | `now()` | |

**主キー**: `id`（UUID）

**外部キー**

| カラム名 | 参照先テーブル.カラム | ON DELETE | 備考 |
|---|---|---|---|
| `mail_id` | `emails.id` | RESTRICT | 本システムではメールの物理削除は行わず PII マスクで対応するため、RESTRICT で整合性を保護する |

**インデックス**

| インデックス名 | 対象カラム | 種別 | パーシャル条件 |
|---|---|---|---|
| `idx_sent_reply_embeddings_embedding` | `embedding` | HNSW（`vector_cosine_ops`, `m=16`, `ef_construction=64`） | なし |
| `idx_sent_reply_embeddings_mail_id` | `mail_id` | B-tree | なし |

**特記事項**: 受信から 90日後に `anonymized_text` をクリア（`pii_masked_at` を記録）。`embedding` は 90日後もクリアしない（RAG コンテキストとして保持）。

---

#### テーブル名: `settings`

**用途・区分**: 現在値 — OpenClaw 設定値の永続化。backend/admin 設定画面または管理 CLI から `GET/PUT /v1/settings` 経由で更新される。HUD MVP はこの API を呼び出さない（REQ-CONFIG-001）

**カラム一覧**

| カラム名 | 型 | NULL | DEFAULT | 制約/備考 |
|---|---|---|---|---|
| `id` | UUID | NOT NULL | `gen_random_uuid()` | PK |
| `key` | TEXT | NOT NULL | — | UNIQUE NOT NULL。設定キー |
| `value` | JSONB | NOT NULL | — | 設定値（型は OpenAPI OpenClawSettings スキーマ準拠） |
| `updated_at` | TIMESTAMPTZ | NOT NULL | `now()` | |

**主キー**: `id`（UUID）

**外部キー**

なし（他テーブルとの FK リレーションなし）

**インデックス**

| インデックス名 | 対象カラム | 種別 | パーシャル条件 |
|---|---|---|---|
| `idx_settings_key` | `key` | UNIQUE B-tree | なし |

**特記事項**: 設定キーごとに1行で保存し、API層で集約して `OpenClawSettings` レスポンスを構築する。含まれるキー例は `organizationDomain`、`businessHours`、`pollEnabled`、`faqCategories`、`promptOverrides`、`dwdAllowlistEmails`、`businessUnits`。`dwdAllowlistEmails` キー欠落または null はアプリ層で空配列 `[]` に正規化し、DwD 書き込みを fail-closed で全スキップする（RC-DWD-001）。`businessUnits` 欠落・null・空配列も `[]` に正規化し、BU 共有 Gmail polling、Calendar events 取得、Calendar 書き込み、Gmail 自己登録の BU 重複判定を fail-closed で扱う（C-12 / C-16 / D-14 / D-16）。

---

## リレーション一覧

全 FK を以下に一覧化する。

| 子テーブル | カラム | 親テーブル | 参照カラム | ON DELETE | NULL 可否 |
|---|---|---|---|---|---|
| `timeline_events` | `mail_id` | `emails` | `id` | SET NULL | NULL 許容 |
| `event_inbox` | `mail_id` | `emails` | `id` | SET NULL | NULL 許容 |
| `event_inbox_recipients` | `event_id` | `event_inbox` | `event_id` | CASCADE | NOT NULL |
| `calendar_proposals` | `mail_id` | `emails` | `id` | CASCADE | NOT NULL |
| `calendar_proposals` | `parent_proposal_id` | `calendar_proposals` | `proposal_id` | SET NULL | NULL 許容 |
| `proposal_approvals` | `proposal_id` | `calendar_proposals` | `proposal_id` | CASCADE | NOT NULL |
| `calendar_operations` | `mail_id` | `emails` | `id` | RESTRICT | NOT NULL |
| `calendar_operations` | `proposal_id` | `calendar_proposals` | `proposal_id` | RESTRICT | NOT NULL |
| `calendar_operation_results` | `operation_id` | `calendar_operations` | `operation_id` | RESTRICT | NOT NULL |
| `faq_entries` | `source_mail_id` | `emails` | `id` | SET NULL | NULL 許容 |
| `sent_reply_embeddings` | `mail_id` | `emails` | `id` | RESTRICT | NOT NULL |

**削除制約の考え方まとめ**

| ON DELETE | 対象 FK | 理由 |
|---|---|---|
| CASCADE | `event_inbox_recipients.event_id`, `calendar_proposals.mail_id`, `proposal_approvals.proposal_id` | 子レコードはイベント/メール/proposalのライフサイクルに完全従属するため |
| RESTRICT | `calendar_operations.mail_id`, `calendar_operations.proposal_id`, `calendar_operation_results.operation_id`, `sent_reply_embeddings.mail_id` | 操作中・結果残存中の親レコード削除を禁止し、冪等性・整合性を保護するため |
| SET NULL | `timeline_events.mail_id`, `event_inbox.mail_id`, `calendar_proposals.parent_proposal_id`, `faq_entries.source_mail_id` | 親レコード削除後も子レコードを保持（監査・通知継続・独立ナレッジ・代替案履歴） |

---

## 未確定事項

| ID | 優先度 | 内容 | 影響テーブル |
|---|---|---|---|
| OQ-DB-005 | Low | JSONB カラムへの GIN インデックス必要性の評価。MVP 時点ではフルスキャンで十分なため未作成 | `emails`、`calendar_proposals`、`event_inbox` |
| RC-FAQ-PII-001 | **CLOSED 2026-07-15** | `created_by_attendee_ref`へ置換 | `faq_entries` |
| OQ-MULTI-005 | Low | Proposal timeout behavior（still OPEN） | `calendar_proposals`、`proposal_approvals` |

---

## 関連文書

| 文書名 | パス | バージョン |
|---|---|---|
| DB設計書（展開元） | `docs/specs/gmail-ai-secretary/db_design_document.md` | v1.7 |
| ER図 | `docs/specs/gmail-ai-secretary/er_diagram.md` | v1.7 |
| 要件定義書 | `docs/specs/gmail-ai-secretary/requirements_definition.md` | v8.13（更新日 2026-07-07） |
| リーン RTM | `docs/specs/gmail-ai-secretary/history/lean-rtm.md` | v8.16 |
