# DB設計書: OpenClaw AI秘書

## 物理スキーマ同期状況（2026-07-16）

実装時の最上位正本は[`001_initial.sql`](../../../migrations/001_initial.sql)と[`002_remediation.sql`](../../../migrations/002_remediation.sql)である。現在の物理スキーマは24テーブルで、後者に`mailbox_poll_state`、`sent_reply_embeddings`、`user_invitations`、`error_acknowledgements`、`provider_credentials`、`operational_alerts`を追加した。実装済みテーブル一覧と保持方針は[現行実装ベースライン](../../implementation/current-implementation.md)を参照する。

本書にmigrationと異なるカラム、制約、index、状態値がある場合、本書は目標論理設計として扱い、DDLを優先する。差分を解消する際は先にmigrationを追加し、その同じ変更で本書を更新する。

作成日: 2026-06-02 | バージョン: 2.2 | 更新日: 2026-07-15 (D-47〜D-53 反映: timeline enum 復元・状態対応表・実行終端遷移・force-claim・subject bind・retention 補完) | ステータス: DRAFT
依拠要件: requirements_definition.md (updated 2026-07-15)

---

## 文書概要

本文書は OpenClaw（GCP Cloud Run）が管理する Cloud SQL PostgreSQL データベースの設計を定義する。
テーブル定義、インデックス、制約、削除ポリシー、pgvector 構成を記述する。
`db_columns_list_with_relations.md` と `er_diagram.md` は、本書から展開済みの補助文書であり、本書を正本として三点整合を維持する。

---

## 目的

- Cloud SQL PostgreSQL のスキーマ設計を実装者が迷わず実装できる状態にする
- pgvector によるベクトル検索の構成を明確にする
- 追記専用テーブル・現在値テーブル・イベントキューの用途区分を明確にする
- データ保持・削除ポリシーを定義し、個人情報管理義務を果たす

---

## 対象範囲

| テーブル名 | 区分 | 概要 |
|---|---|---|
| `users` | 現在値 | **[NEW]** マルチユーザー認証 allowlist。google_subject_hash と attendee_ref の対応を管理 |
| `business_units` | 現在値 | 不変BU識別子と共有Calendar account |
| `business_unit_memberships` | 現在値 | 有効期間付きBU所属・title pattern |
| `user_roles` | 現在値 | FAQ reviewer / BU supervisor権限 |
| `oauth_sessions` | 現在値 | OAuth state/PKCE/handoffの期限・単回消費状態 |
| `emails` | 現在値 | 受信メール本文・分析結果・対応ステータスの正本 |
| `mailbox_poll_state` | 現在値 | mailbox ごとの Gmail History API checkpoint と full-sync 回復状態 |
| `mail_send_operations` | 現在値 | Gmail draft/send 外部副作用の冪等台帳と不明結果の照合状態 |
| `timeline_events` | 追記専用 | メール受信から最終処置までの全操作履歴 |
| `event_inbox` | イベントキュー | HUD polling 向け通知イベント本体 |
| `event_inbox_recipients` | イベントキュー | event_inbox の宛先ユーザーとユーザー単位 ACK 状態 |
| `calendar_proposals` | 現在値 | スケジュール調整案（候補スロット・集約承認状態） |
| `proposal_approvals` | 現在値 | **[NEW]** 参加者ごとの承認状態・approvalToken を管理 |
| `calendar_operations` | 現在値 | Calendar 更新操作の冪等状態管理 |
| `calendar_operation_results` | 現在値 | 参加者別 Calendar 更新結果 |
| `outbox_events` | イベントキュー | DB commit と Cloud Tasks dispatch を橋渡しする transactional outbox |
| `faq_candidates` | 現在値 | FAQ 候補本文を event_inbox から分離してアクセス制御する保管先 |
| `faq_entries` | 現在値 | FAQ ナレッジ（pgvector 埋め込みあり） |
| `sent_reply_embeddings` | 現在値 | 送信済み返信履歴（pgvector 埋め込みあり、匿名化済み） |
| `settings_revisions` | 追記型 | ETag/If-Matchで更新するOpenClaw設定revision |

---

## 前提

| # | 前提条件 |
|--|---|
| P-01 | Cloud SQL PostgreSQL（バージョン 15 以上）と pgvector 拡張が有効化されていること |
| P-02 | Cloud Run と Cloud SQL は同一 GCP リージョンに配置されること（REQ-STORE-001）|
| P-03 | 1組織の共有バックエンドで複数ユーザー／複数 BU を扱う。全 resource query は mailbox_ref、owner_attendee_ref または business_unit_ref で認可境界を適用する。将来の複数組織収容時は organization_id を全正本へ追加する |
| P-04 | HUD（Electron）は Cloud SQL に直接接続しない（REQ-DATA-001）|
| P-05 | 全文字列は UTF-8 で格納する |
| P-06 | タイムスタンプはすべて `TIMESTAMPTZ`（UTC 保存）とする |

---

## スキーマ設計方針

### スキーマ

単一スキーマ（`public`）を使用する。MVP は1組織専用デプロイのため organization_id は持たないが、ユーザー／BU間の resource authorization は必須とする。

### 命名規則

| 対象 | 規則 | 例 |
|---|---|---|
| テーブル名 | snake_case、複数形 | `emails`、`timeline_events` |
| カラム名 | snake_case | `mail_id`、`created_at` |
| インデックス名 | `idx_<テーブル名>_<カラム名>` | `idx_emails_status` |
| 制約名 | `<テーブル名>_<説明>_check` | `emails_status_check` |
| UUID | PostgreSQL `gen_random_uuid()` を使用 | |
| プライマリキー | 原則 UUID v4 の `id` カラム | |

### テーブル区分の使い分け

| 区分 | 特徴 | 対象テーブル |
|---|---|---|
| 現在値テーブル | UPDATE/DELETE を許容。最新状態を管理 | users、business_units、business_unit_memberships、user_roles、oauth_sessions、emails、mailbox_poll_state、mail_send_operations、calendar_proposals、calendar_operations、calendar_operation_results、faq_candidates、faq_entries、sent_reply_embeddings |
| 追記専用テーブル | INSERT のみ。PostgreSQL トリガーで UPDATE/DELETE を禁止 | timeline_events |
| イベントキューテーブル | 非同期配送の本体と状態を管理。通知は全宛先 ACK 後、outbox は dispatch 後に定期 DELETE | event_inbox、event_inbox_recipients、outbox_events |

---

## テーブル定義

### users（NEW）

**用途**: マルチユーザーバックエンドの認証 allowlist。Google ID token の `sub` を SHA-256 化した `google_subject_hash` と `attendee_ref`（Calendar 操作の疑似識別子）の対応を管理する。`ALLOWED_SUBJECT` 環境変数に代わり、このテーブルが認証の唯一の allowlist となる（C-15 / D-17）。

**主なカラム**:

| カラム名 | 型 | 制約 | 説明 |
|---|---|---|---|
| `id` | UUID | PK | |
| `google_subject_hash` | TEXT | UNIQUE NULL | sha256(Google ID token `sub`)。認証 allowlist の主キー的役割。BU ユーザーは管理者登録時点では NULL（`sub` は本人初回ログインまで不明）で、bind-on-first-login で1回限り確定する（D-50） |
| `pending_email_hash` | TEXT | NULL | BU ユーザー事前登録時の仮バインド識別子（sha256(組織メールアドレス)）。初回ログインで ID token の `email` claim ハッシュと照合し、`google_subject_hash` 確定後にクリアする（D-50）。生メールアドレスは保存しない |
| `attendee_ref` | UUID | UNIQUE NOT NULL | 登録時にランダム生成される不変のサロゲート ID。Calendar 操作・proposal_approvals・Secret Manager キーの参加者識別子。titlePattern との対応は `business_unit_memberships` が保持する |
| `workspace_access_type` | TEXT | NOT NULL | `personal_oauth`（個人 Workspace アカウント。gmail.readonly + gmail.compose + calendar.events + calendar.events.freebusy を OAuth refresh token で管理）/ `business_unit_dwd`（事業部共有アカウント経由。DwD で Gmail + Calendar の両方にアクセス） |
| `provisioning_status` | TEXT | NOT NULL DEFAULT 'active' | `oauth_provisioning`（個人: Secret 保存完了前）/ `pending_subject_bind`（BU: 初回ログインによる subject 確定前。D-50）/ `active` / `disabled`。`active` 以外は通常 API 認証を許可しない |
| `provisioning_started_at` | TIMESTAMPTZ | | 停滞した OAuth provisioning を補償処理する基準時刻 |
| `last_seen_at` | TIMESTAMPTZ | | 最終 HUD アクセス日時 |
| `created_at` | TIMESTAMPTZ | NOT NULL DEFAULT now() | |
| `updated_at` | TIMESTAMPTZ | NOT NULL DEFAULT now() | |

**インデックス**:
- `idx_users_google_subject_hash` — UNIQUE（認証 middleware の DB 照合）
- `idx_users_attendee_ref` — UNIQUE（Calendar 操作・proposal_approvals 参照）

**制約**:
- `users_workspace_access_type_check`: workspace_access_type IN ('personal_oauth', 'business_unit_dwd')
- `users_provisioning_status_check`: provisioning_status IN ('oauth_provisioning', 'pending_subject_bind', 'active', 'disabled')
- `users_bind_check`: provisioning_status = 'pending_subject_bind' の行は `pending_email_hash IS NOT NULL`、`active` の行は `google_subject_hash IS NOT NULL` を満たす

**特記事項**:
- 個人 OAuth exchange は ID token 検証後に `users` を `oauth_provisioning` で冪等作成し attendee_ref を確定してから Secret Manager に refresh token を保存し、保存成功後にだけ `active` へ遷移する。Secret 書込み失敗時は行を残して再試行し、期限超過行は補償ジョブが無効化する
- 通常 API の認証 middleware は `active` 行のみ許可する。未登録 subject を通す例外経路は作らず、Gateway の exchange 専用内部 API だけが provisioning を実行する
- BU ユーザーの bind-on-first-login（D-50）: 管理者登録時は `pending_email_hash` のみ保存（`pending_subject_bind`）。本人初回ログインの ID token（署名・`hd` 検証済み）の `email` claim ハッシュが一致した場合のみ `google_subject_hash` を1回限り確定し、`pending_email_hash` をクリアして `active` へ遷移、`timeline_events: user_bound` を記録する。不一致・二重バインド試行は 403
- `attendee_ref` は `crypto.randomUUID()` で登録時に生成する不変値（D-33）。`perUserSalt` は `mailbox_ref` の生成にのみ使用を継続する
- 氏名・メールアドレス・OS ユーザー名などの PII は保存しない

---

### business_units / business_unit_memberships

**用途**: BU識別子と有効期間付き所属を認可のリレーショナル正本として管理する。`settings` のJSONを認可判定に使用しない。

- `business_units.id` は初回作成時にbackendが採番し、物理削除・ID変更を禁止する。廃止は `disabled_at` で表す。
- `business_unit_memberships` は `(business_unit_ref, attendee_ref, active_from)` を主キーとし、同一組合せのactive行は1件に制限する。
- `title_pattern` は同一BU内のactive行で一意、最大200文字とする。実装は正規表現ではなく正規化済みliteral照合を既定とする。
- 管理者ユーザー登録は `users` と所属を1トランザクションで作成する。offboardingは `active_until` を設定し、過去の監査参照を保持する。
- FAQ reviewer / BU supervisor権限は `user_roles` の有効な行を正本とする。

---

### emails

**用途**: 受信メールの本文・分析結果・対応ステータスを管理する正本テーブル。

**主なカラム**:

| カラム名 | 型 | 制約 | 説明 |
|---|---|---|---|
| `id` | UUID | PK | メール識別子（内部） |
| `gmail_id` | TEXT | NOT NULL | Gmail message ID。mailbox 間での一意性を仮定しない |
| `thread_id` | TEXT | NOT NULL | Gmail thread ID |
| `mailbox_ref` | TEXT | NOT NULL | 受信 mailbox を特定する疑似識別子。sha256(gmailAccount + perUserSalt)。per-mailbox visibility 制御に使用する。生 Gmail アドレスは保存しない（D-22 / C-17） |
| `owner_attendee_ref` | TEXT | FK(users.attendee_ref) NULL | 個人mailboxの所有者。BU共有メールではNULL |
| `business_unit_ref` | UUID | NULL | BU共有mailboxの不変BU識別子。個人メールではNULL |
| `from_address` | TEXT | NOT NULL | 差出人メールアドレス [PII] |
| `subject` | TEXT | NOT NULL | 件名 |
| `body_preview` | TEXT | | [PII] 本文先頭 500 文字 |
| `received_at` | TIMESTAMPTZ | NOT NULL | 受信日時 |
| `status` | TEXT | NOT NULL DEFAULT '未対応' | `processing`（draft 作成前の先行 INSERT 状態。orphan draft 防止・A-2/D-36）/ `未対応`（返信要・スケジュール変更なし・HUD 承認待ち）/ `pending_calendar`（スケジュール変更あり・Calendar 承認待ち・返信下書き保留中）/ `pending_reply_approval`（Calendar 全員承認完了・返信下書き HUD 承認待ち）/ `draft_missing`（承認時に Gmail draft が 404。replyDraft から再作成可能・B-4/D-36）/ `対応中` / `回答済み` / `解決済み` / `保留` |
| `category` | TEXT | | AI 判定カテゴリ（7種） |
| `urgency` | TEXT | | `高` / `中` / `低` / `なし` |
| `summary` | TEXT | | 3行要約 |
| `actions` | JSONB | NOT NULL DEFAULT '[]' | 必要アクションの文字列配列。型不正な AI 出力は保存しない |
| `analysis_status` | TEXT | NOT NULL DEFAULT 'pending' | `pending` / `succeeded` / `failed` / `skipped_bounce` |
| `analysis_error_code` | TEXT | | allowlist 済み非PII理由コード。raw model response や例外本文は保存しない |
| `card_type` | TEXT | NOT NULL DEFAULT 'manual_action_required' | `approval_ready` / `manual_action_required` / `bounce_notice` |
| `sender_intent` | TEXT | | 送信者意図（40文字以内） |
| `reply_required` | BOOLEAN | NOT NULL DEFAULT true | 返答要否 |
| `is_schedule` | BOOLEAN | NOT NULL DEFAULT false | スケジュール関連フラグ |
| `scheduling_type` | TEXT | | `datetime_specified` / `open_ended` |
| `proposed_datetimes` | JSONB | | 提案日時リスト（datetime_specified 時のみ） |
| `participants` | JSONB | | 参加者リスト [PII] |
| `draft_id` | TEXT | | Gmail 下書き ID |
| `reply_draft_envelope` | JSONB | | AES-256-GCM暗号封筒。version/algorithm/ciphertext/encryptedDek/nonce/tag/aadDigest/keyVersionを必須とする |
| `approval_token_hash` | TEXT | | Gmail承認操作許可トークンのSHA-256ハッシュ。プレーンテキストはDB・event_inbox・ログに保存しない（RC-TOKEN-001-HASH） |
| `approval_token_envelope` | JSONB | | claimantがdetail取得時に同一tokenを再取得するための暗号封筒。AADへmailId/cardVersionをbindする |
| `approval_subject_hash` | TEXT | | 承認者 Google subject の SHA-256 ハッシュ。別ユーザーによる token 利用を拒否するための疑似識別子 |
| `card_version` | INTEGER | NOT NULL DEFAULT 1 | Gmail承認カードの stale 検出用バージョン |
| `token_expires_at` | TIMESTAMPTZ | | Gmail承認トークン有効期限 |
| `approval_token_consumed_at` | TIMESTAMPTZ | | 承認/拒否でトークンを単回使用済みにした時刻 |
| `claimer_attendee_ref` | TEXT | NULL | BU 共有メールのクレーム保持者の attendee_ref。NULL = 未着手。クレーム取得時に設定し、解除・移譲・2h タイムアウト時に NULL にリセットする。`pending_calendar` 中は自動タイムアウト解除しない。個人 mailbox のメールには使用しない（D-26 / D-27） |
| `claimed_at` | TIMESTAMPTZ | NULL | クレーム取得日時。claimを必要とする全commandが2時間期限をSQL条件で評価し、一覧取得には依存しない。`pending_calendar` は2時間解除対象外だが、24時間後は同一BUのactive memberが自分宛に強制引き取りできる |
| `hud_display_ready` | BOOLEAN | NOT NULL DEFAULT false | HUD polling 対象フラグ |
| `pii_masked_at` | TIMESTAMPTZ | | retention job によるPIIマスク完了時刻 |
| `created_at` | TIMESTAMPTZ | NOT NULL DEFAULT now() | |
| `updated_at` | TIMESTAMPTZ | NOT NULL DEFAULT now() | |

**インデックス**:
- `idx_emails_mailbox_gmail_id` — UNIQUE (`mailbox_ref`, `gmail_id`)（mailbox 単位の重複取り込み防止・ON CONFLICT DO NOTHING）
- `idx_emails_status` — WHERE status IN ('未対応', '対応中', 'pending_calendar', 'pending_reply_approval')（承認カード polling 高速化）
- `idx_emails_hud_display_ready` — WHERE hud_display_ready = true（GET /v1/mail/pending 高速化）
- `idx_emails_received_at` — 受信日時降順（タイムライン表示）
- `idx_emails_mailbox_ref` — per-mailbox visibility フィルタリング（GET /v1/mail/pending の mailbox_ref 絞り込み）
- `idx_emails_owner_attendee_ref` — 個人owner resource authorization
- `idx_emails_business_unit_ref` — BU membership resource authorization
- `idx_emails_claimer_attendee_ref` — クレーム保持者別フィルタリング（GET /v1/mail/tickets の担当者絞り込み、v2）

**制約**:
- `emails_status_check`: status IN ('processing', '未対応', 'pending_calendar', 'pending_reply_approval', 'draft_missing', '対応中', '回答済み', '解決済み', '保留')
- `emails_analysis_status_check`: analysis_status IN ('pending', 'succeeded', 'failed', 'skipped_bounce')
- `emails_card_type_check`: card_type IN ('approval_ready', 'manual_action_required', 'bounce_notice')
- `(owner_attendee_ref IS NOT NULL) <> (business_unit_ref IS NOT NULL)` をCHECKし、個人ownerかBUのどちらか一方へ必ず所属させる
- `processing` かつ `draft_id IS NULL` の行は orphan draft 回復対象。次回ポーリングで検出し、Gmail drafts.list で既存 draft を再利用または再作成する（D-36）
- `emails_urgency_check`: urgency IN ('高', '中', '低', 'なし')
- Gmail承認操作では `id` + `approval_subject_hash` + `card_version` + `token_expires_at` + `approval_token_hash` を検証し、承認/拒否時に `approval_token_consumed_at` を設定して単回使用を強制する。HUDに渡すプレーンテキストtokenは認証済みカード取得レスポンスでのみ返し、DB・event_inbox・ログには保存しない
- BU共有メールの初回 token は claim 成功トランザクションでのみ発行する。未 claim、解除、timeout の状態では `approval_subject_hash` / `approval_token_hash` / `token_expires_at` を NULL にし、claimant 以外へ draft/token を返さない

**メール状態対応表（正本。D-47）**:

| DB 値（emails.status） | API 値（MailTicket 等） | 旧フロー図表記 | card_type との関係 |
|---|---|---|---|
| `processing` | （API 非公開。hud_display_ready=false） | — | — |
| `未対応` | `unhandled` | `pending_approval` | approval_ready / manual_action_required / bounce_notice |
| `pending_calendar` | `pending_calendar` | 同名 | approval_ready（Calendar 投票カード） |
| `pending_reply_approval` | `pending_reply_approval` | 同名 | approval_ready |
| `draft_missing` | `draft_missing` | — | manual_action_required |
| `対応中` | `in_progress` | — | — |
| `回答済み` | `answered` | `approved`（承認・送信完了） | — |
| `解決済み` | `resolved` | — | — |
| `保留` | `pending` | `rejected`（拒否後の手動対応） | — |

> フロー図・設計文書は今後 DB 値（左列）で表記する。`pending_approval` / `approved` / `rejected` という状態名は enum に存在しないため使用しない。

---

### mailbox_poll_state

**用途**: Gmail History API の差分取得 checkpoint を mailbox 単位で管理し、全件再走査と mailbox 間の障害波及を防ぐ。

| カラム名 | 型 | 制約 | 説明 |
|---|---|---|---|
| `mailbox_ref` | TEXT | PK | 疑似 mailbox 識別子 |
| `last_history_id` | TEXT | | 次回 `users.history.list` の startHistoryId。初回または期限切れ時は NULL |
| `last_success_at` | TIMESTAMPTZ | | 差分取得と保存が完了した時刻 |
| `sync_status` | TEXT | NOT NULL DEFAULT 'bootstrap_required' | `bootstrap_required` / `incremental` / `full_sync_required` / `disabled` |
| `failure_count` | INTEGER | NOT NULL DEFAULT 0 | mailbox 単位の連続失敗回数 |
| `next_attempt_at` | TIMESTAMPTZ | | exponential backoff と jitter 適用後の再試行時刻 |
| `updated_at` | TIMESTAMPTZ | NOT NULL DEFAULT now() | |

- History ID が無効／期限切れなら `full_sync_required` に遷移し、限定期間の message list と `(mailbox_ref, gmail_id)` UPSERT で回復してから新 checkpoint を保存する。
- checkpoint は、その履歴ページ由来の全 email/event 保存と同じ DB transaction の最後に前進させる。ページ処理失敗時は進めない。
- Scheduler 全体の固定 lock に加え、実処理は `pg_try_advisory_lock(1, hashtext(mailbox_ref))` で mailbox 単位に排他し、設定された上限内で並列実行する。

---

### mail_send_operations

**用途**: Gmail draft 作成・送信の外部副作用を冪等化し、HTTP timeout 後の二重送信を防ぐ。

| カラム名 | 型 | 制約 | 説明 |
|---|---|---|---|
| `operation_id` | UUID | PK | API が発行する不透明 ID |
| `mail_id` | UUID | FK(emails) NOT NULL | 対象メール |
| `card_version` | INTEGER | NOT NULL | 承認対象 revision |
| `idempotency_key` | TEXT | UNIQUE NOT NULL | sha256(mail_id + card_version + approved draft digest) |
| `status` | TEXT | NOT NULL | `prepared` / `draft_created` / `sending` / `succeeded` / `result_unknown` / `failed_terminal` |
| `draft_id` | TEXT | | 照合用 Gmail draft ID |
| `sent_message_id` | TEXT | | 成功照合後の Gmail message ID |
| `operation_marker` | TEXT | UNIQUE NOT NULL | Gmail 作成物に付与する決定的な内部照合マーカー。本文・ログ・HUDには露出しない |
| `attempt_count` | INTEGER | NOT NULL DEFAULT 0 | transport attempt 数 |
| `last_error_code` | TEXT | | allowlist 済み非PIIコード |
| `created_at` | TIMESTAMPTZ | NOT NULL DEFAULT now() | |
| `updated_at` | TIMESTAMPTZ | NOT NULL DEFAULT now() | |

- `UNIQUE(mail_id, card_version)` を設定し、同じ承認の操作行を再利用する。
- `sending` で停止した操作は draft/message ID と operation_marker を Gmail 側で照合する。送信済みと確定できれば `succeeded`、未送信と確定できる場合だけ再試行し、判定不能なら `result_unknown` として手動確認へ送る。
- token 消費、操作行作成、email status 遷移は1 transaction で行い、Gmail API 呼出しは commit 後に実行する。

---

### timeline_events

**用途**: メール受信から最終処置までの全操作を追記専用で記録する監査テーブル。UPDATE・DELETE は PostgreSQL トリガーで禁止する。

**主なカラム**:

| カラム名 | 型 | 制約 | 説明 |
|---|---|---|---|
| `id` | UUID | PK | |
| `mail_id` | UUID | FK(emails) NULL | 対象メール。OpenClaw停止などメール未特定のcriticalではNULL |
| `event_type` | TEXT | NOT NULL | イベント種別（下記 enum 参照） |
| `operator` | TEXT | | MVP は NULL またはシステム識別子（例: `hud-system`）のみ。OSユーザー名などPIIは保存しない（OQ-DB-003 CLOSED） |
| `detail` | TEXT | | 非PII allowlist の追加情報のみ。許可: `operationId`、`status`、`correlationId`、非PII skip reason、`errorCode`、`exceptionClass`。raw エラーメッセージ、stack trace、メール本文・件名・氏名・メールアドレス・token は禁止 |
| `correlation_id` | UUID | | エラー相関 ID |
| `timestamp` | TIMESTAMPTZ | NOT NULL DEFAULT now() | |

**event_type 列挙値**（D-47 で正本拡張）:
`received` / `analyzed` / `hud_shown` / `approved` / `rejected` / `sent` / `mail_claimed` / `mail_unclaimed` / `mail_transferred` / `mail_force_claimed` / `mail_bounced` / `token_reissued` / `send_result_unknown` / `user_provisioned` / `user_bound` / `user_disabled` / `cal_participant_approved` / `cal_participant_rejected` / `cal_all_approved` / `cal_any_rejected` / `cal_selection_conflict` / `cal_succeeded` / `cal_partial_failed` / `cal_replan_required` / `cal_replanned` / `cal_candidate_limited` / `cal_superseded` / `cal_cancelled` / `faq_suggested` / `faq_registered` / `draft_saved` / `draft_deleted` / `error_minor` / `error_critical`

> `cal_participant_approved` / `cal_participant_rejected`: 参加者1名の承認/拒否操作。`detail` に attendee_ref・card_version を含め氏名・メールは含めない。
> `cal_all_approved` / `cal_any_rejected` / `cal_selection_conflict`: 全員の集約結果または即時拒否結果が確定した時点で記録。
> `cal_cancelled`（D-34）/ `token_reissued`（OQ-TOKEN-002）/ `mail_bounced`（BE-REQ-038）/ `send_result_unknown`（D-43）/ `cal_replan_required`（D-40/D-48）/ `mail_force_claimed`（D-49）/ `user_provisioned`・`user_bound`・`user_disabled`（D-37/D-50）。
> ⚠️ この enum は要件（BE-REQ-017/032/038 等）が参照する監査イベントの正本。縮小は要件との突合なしに行わない（D-47）。

**インデックス**:
- `idx_timeline_events_mail_id` — メール別履歴参照
- `idx_timeline_events_timestamp` — 時系列参照

**FK 削除制約:**
- `mail_id → emails(id)`: ON DELETE SET NULL（監査ログは追記専用・メール削除後も監査記録を保持するため。NULL 許容カラムのため SET NULL で整合性を維持する）

**トリガー**:
```sql
CREATE OR REPLACE FUNCTION prevent_timeline_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'timeline_events は追記専用です。UPDATE/DELETE は禁止されています。';
END;
$$;

CREATE TRIGGER trg_timeline_no_update
  BEFORE UPDATE ON timeline_events
  FOR EACH ROW EXECUTE FUNCTION prevent_timeline_mutation();

CREATE TRIGGER trg_timeline_no_delete
  BEFORE DELETE ON timeline_events
  FOR EACH ROW EXECUTE FUNCTION prevent_timeline_mutation();
```

---

### event_inbox

**用途**: HUD polling（GET /v1/events）向けの非同期通知本体。OpenClaw が INSERT し、宛先と ACK 状態は `event_inbox_recipients` でユーザーごとに管理する。

**主なカラム**:

| カラム名 | 型 | 制約 | 説明 |
|---|---|---|---|
| `event_id` | UUID | PK | |
| `type` | TEXT | NOT NULL | イベント種別（下記 enum 参照） |
| `mail_id` | UUID | FK(emails) NULL | 関連メール ID |
| `operation_id` | TEXT | NULL | 関連 Calendar operation ID。sha256由来の決定的ID |
| `payload` | JSONB | NOT NULL | OpenAPI Event.payload に対応する型付きデータ |
| `created_at` | TIMESTAMPTZ | NOT NULL DEFAULT now() | |

**type 列挙値**:
`mail_approval_ready`（Branch A: 返信承認カード表示）/ `mail_reply_ready`（Branch B: Calendar 承認完了後の返信承認カード表示トリガー）/ `mail_claimed`（クレーム取得通知、BU 全員）/ `mail_unclaimed`（クレーム解除通知、BU 全員）/ `mail_transferred`（クレーム移譲通知、BU 全員）/ `calendar_proposals_ready` / `calendar_alternatives_ready` / `faq_candidate` / `calendar_operation_succeeded` / `calendar_operation_failed` / `critical_error` / `status_changed`

**インデックス**:
- `idx_event_inbox_created_at_event_id` — B-tree on `(created_at, event_id)`（cursor 安定順序）
- `idx_event_inbox_mail_id` — メール別参照

**FK 削除制約:**
- `mail_id → emails(id)`: ON DELETE SET NULL（メール削除後も通知本体（`type`・`payload`）を保持し、HUD への通知処理を継続するため）

**保持ポリシー**: `event_inbox_recipients` の全宛先が ACK 済みで、最後の `acked_at` から 7日経過したレコードを定期削除（Cloud Scheduler または Cloud Run 起動時バッチ）。

---

### event_inbox_recipients（NEW）

**用途**: `event_inbox` の通知をどの HUD ユーザーへ配信するか、各ユーザーが ACK 済みかを管理する。BU 共有 mailbox の通知は BU 全 members 分の recipient 行を作り、個人 mailbox の通知は本人 1 行だけを作る（D-22）。Aさんが ACK しても Bさん/Cさんの未読状態を消さないため、ACK 状態はこのテーブルでユーザーごとに持つ。

**主なカラム**:

| カラム名 | 型 | 制約 | 説明 |
|---|---|---|---|
| `event_id` | UUID | PK, FK(event_inbox) NOT NULL | 対象イベント |
| `target_user_ref` | TEXT | PK, NOT NULL | このイベントを受け取る attendee_ref |
| `acked_at` | TIMESTAMPTZ | | このユーザーが `POST /v1/events/{eventId}/ack` で ACK した時刻。NULL = 未ACK |
| `created_at` | TIMESTAMPTZ | NOT NULL DEFAULT now() | |

**インデックス**:
- `idx_event_inbox_recipients_unacked_user` — partial B-tree on `(target_user_ref, event_id) WHERE acked_at IS NULL`（GET /v1/events の未ACK取得）
- `idx_event_inbox_recipients_event_id` — B-tree on `(event_id)`（全宛先 ACK 判定・cleanup）

**制約**:
- PRIMARY KEY (`event_id`, `target_user_ref`)

**ACK処理**:
- `GET /v1/events` は `event_inbox_recipients.target_user_ref = caller_attendee_ref` かつ `acked_at IS NULL` の行を `event_inbox` と JOIN して返す。
- `POST /v1/events/{eventId}/ack` は caller の recipient 行だけを `acked_at = COALESCE(acked_at, now())` で冪等に更新する。caller の recipient 行がない場合は 403。
- cleanup は対象 event に `acked_at IS NULL` の recipient 行が存在しないことを確認し、`max(acked_at) < now() - interval '7 days'` の event_inbox を削除する。recipient 行は `ON DELETE CASCADE` で削除される。

**FK 削除制約:**
- `event_id → event_inbox(event_id)`: ON DELETE CASCADE（通知本体削除時に宛先/ACK状態も削除する）

---

### outbox_events

**用途**: Calendar operation 等の domain transaction と Cloud Tasks 作成を原子的に接続する。承認 transaction は operation と outbox を同時に commit し、dispatcher が後から配送する。

| カラム名 | 型 | 制約 | 説明 |
|---|---|---|---|
| `outbox_id` | UUID | PK | |
| `event_type` | TEXT | NOT NULL | `calendar_operation_dispatch` 等の allowlist |
| `aggregate_id` | TEXT | NOT NULL | operation_id。PII は禁止 |
| `payload` | JSONB | NOT NULL | operation_id と schema_version のみ。実行計画・token・メール本文は含めない |
| `status` | TEXT | NOT NULL DEFAULT 'pending' | `pending` / `dispatching` / `dispatched` / `dead_letter` |
| `attempt_count` | INTEGER | NOT NULL DEFAULT 0 | dispatch attempt 数 |
| `next_attempt_at` | TIMESTAMPTZ | NOT NULL DEFAULT now() | exponential backoff + jitter |
| `lease_expires_at` | TIMESTAMPTZ | | `FOR UPDATE SKIP LOCKED` dispatcher lease の期限 |
| `task_name` | TEXT | | 決定的 Cloud Tasks task name。既存 task は成功扱い |
| `last_error_code` | TEXT | | allowlist 済み非PIIコード |
| `created_at` | TIMESTAMPTZ | NOT NULL DEFAULT now() | |
| `dispatched_at` | TIMESTAMPTZ | | |

- `UNIQUE(event_type, aggregate_id)` で二重 outbox を防ぐ。
- dispatcher は `pending` または lease 切れの `dispatching` を取得し、決定的 task name で作成する。Cloud Tasks の already-exists は `dispatched` として確定する。
- transient failure は `next_attempt_at` を更新して再試行し、上限超過は `dead_letter` と critical alert を記録する。送信済み行は30日後に削除する。

---

### calendar_proposals

**用途**: スケジュール調整案（候補スロット・承認トークン）の正本。ST-05 の状態遷移を管理する。

**主なカラム**:

| カラム名 | 型 | 制約 | 説明 |
|---|---|---|---|
| `proposal_id` | UUID | PK | |
| `parent_proposal_id` | UUID | FK(calendar_proposals) NULL | 拒否後代替案の元 proposal。初回 proposal では NULL |
| `revision` | INTEGER | NOT NULL DEFAULT 1 | 同一メール内の提案世代。代替案生成ごとに増加 |
| `mail_id` | UUID | FK(emails) NOT NULL | 対象メール |
| `scheduling_type` | TEXT | NOT NULL | `datetime_specified` / `open_ended` |
| `proposed_datetimes` | JSONB | | 提案日時リスト（datetime_specified のみ） |
| `conflict_info` | JSONB | | MVPでは NULL 固定。Legal/UX 承認後の将来拡張予約 |
| `slots` | JSONB | NOT NULL | 候補スロット（0〜3件）。slotId/slotStart/slotEnd/rank/scoreReasonCodes/設定済みcontext window/期間外ラベル/衝突有無/手動確認要否を保存する。参加者ごとの予定コンテキストは暗号化またはマスク済みとし、メールアドレス・Google event id・calendar id・会議URL・token は含めない |
| `context` | TEXT | | 生成コンテキスト情報。固定コード/理由のみ |
| `unavailable_attendees` | JSONB | | 空配列、非PII理由コード、または管理外参加者の状態コード（`external_unmanaged` / `not_onboarded` など）。メールアドレスは保存しない |
| `rejection_reason_code` | TEXT | | proposal 全体の代表拒否理由コード。詳細は `proposal_approvals` の参加者別拒否入力に保存する |
| `candidate_count` | INTEGER | NOT NULL DEFAULT 0 | 生成済み候補数。0から3の範囲 |
| `candidate_limit_reason` | TEXT | | 3候補未満の理由コード |
| `alternative_suggestions` | JSONB | | 期間拡張、参加者調整、手動確認などの非PII代替案コード配列 |
| `manual_confirmation_prompt` | JSONB | | 管理外必須参加者がいる場合に HUD へ返す手動確認用テキスト。参加者表示ラベル、候補日時、確認依頼文のみを保存し、メールアドレス・Google event id・calendar id・会議URL・token は保存しない |
| `aggregate_approval_status` | TEXT | NOT NULL DEFAULT 'pending_all' | 全参加者の承認集約状態。`pending_all`（投票待ち）/ `all_approved`（全員が同一 slotId を承認 → operation enqueue）/ `any_rejected`（誰かが拒否 → 代替案フロー）/ `selection_conflict`（全員承認したが slotId が割れた → 代替案フロー）|
| `status` | TEXT | NOT NULL DEFAULT 'active' | `active` / `manual_review_required` / `execution_pending`（operation/outbox commit済み〜worker結果確定前）/ `executed`（全書込み成功確認済み）/ `executed_with_failures`（partial_failed 確定。手動補正カード表示・D-48）/ `superseded` / `cancelled` |
| `created_at` | TIMESTAMPTZ | NOT NULL DEFAULT now() | |
| `updated_at` | TIMESTAMPTZ | NOT NULL DEFAULT now() | |

**インデックス**:
- `idx_calendar_proposals_mail_id` — メール別参照
- `idx_calendar_proposals_parent_proposal_id` — 代替案の親 proposal 参照
- `idx_calendar_proposals_status` — WHERE status IN ('active', 'manual_review_required', 'execution_pending')

**制約**:
- `calendar_proposals_status_check`: status IN ('active', 'manual_review_required', 'execution_pending', 'executed', 'executed_with_failures', 'superseded', 'cancelled')
- `calendar_proposals_aggregate_approval_status_check`: aggregate_approval_status IN ('pending_all', 'all_approved', 'any_rejected', 'selection_conflict')
- `calendar_proposals_revision_check`: revision >= 1（`revision >= 3` の proposal からは replan せず `manual_review_required` / `candidateLimitReason = max_revisions_reached` に遷移する。D-34）
- `calendar_proposals_candidate_count_check`: candidate_count BETWEEN 0 AND 3
- 承認/拒否時の検証は `proposal_approvals` テーブルで per-participant に行う（`calendar_proposals` への単一 approval_token カラムは廃止）

**MVP JSONB 保持ルール（RC-CAL-002 / RC-PII-001 CLOSED）**:
- `conflict_info` は NULL 固定。詳細な衝突情報は公開schemaに明示した slot context のみ返す
- `slots[]` は `slotId`、`slotStart`、`slotEnd`、`rank`、`scoreReasonCodes`、`beforeWindow`、`afterWindow`、`participantContexts`、`isWithinRequestedPeriod`、`periodLabel`、内部専用の `conflictDetected`、`manualCheckRequired`、`candidateLimitReason` のみを許可する。`participantContexts` には参加者表示名、予定タイトル、マスク済み予定本文、予定時刻、参加者表示名を保存できる。メールアドレス・Google event id・calendar id・会議URL・token は保存しない
- `unavailable_attendees` は空配列、非PII理由コード文字列、管理外参加者状態コードのみを許可する。メールアドレスは保存しない
- `context` は `generated_from_busy_free` など固定コードのみとし、メール本文・予定名・参加者識別子を保存しない
- `rejection_reason_code`、`candidate_limit_reason`、`alternative_suggestions` は非PIIコードを基本とする。`manual_confirmation_prompt` はクレーム保持者が社外/管理外参加者に送る確認依頼文を保存できるが、メールアドレス・会議URL・外部IDは含めない。参加者が入力した拒否理由メモは `proposal_approvals.rejection_reason_detail` にメールアドレス等をマスクして保存し、event_inbox / timeline_events / log には出力しない

**FK 削除制約:**
- `mail_id → emails(id)`: ON DELETE CASCADE（調整案はメールのライフサイクルに従属するため、メール削除時に関連する調整案も削除する）
- `parent_proposal_id → calendar_proposals(proposal_id)`: ON DELETE SET NULL（親 proposal が削除された場合も子 proposal の監査状態を保持するため）

**特記事項:**
- per-participant approvalToken は `proposal_approvals` テーブルで管理する。`calendar_proposals` に単一 `approval_token` カラムは持たない（C-13）
- `aggregate_approval_status` は `proposal_approvals` の全行を確認後、Back が更新する。全員 approved かつ `selected_slot_id` が全行で同一のときだけ `all_approved` とし、Cloud Tasks への operation enqueue を行う。`selection_conflict` は全員の回答を待たず、approved 行間に異なる `selected_slot_id` が2つ以上存在した時点で即時遷移する（D-35）
- 拒否・候補選択割れ後の代替案生成では、旧 proposal を `superseded` に遷移し、新 proposal は `parent_proposal_id` と `revision` で世代関係を保持する。代替案生成時は新 proposal_id に対して `proposal_approvals` 行を全参加者分**新規 INSERT** する。旧 proposal の行は不変のまま監査履歴・拒否入力として保持する（append-only。D-20 / D-32）
- superseded / cancelled proposal への approve / reject / reissue-token は `409 + code: proposal_superseded + supersededByProposalId` を返す（D-35）
- `cancelled` への遷移は `POST /cancel` のみ。実行権限は「BU 共有メール = current claimant / 個人 mailbox = `emails.owner_attendee_ref`」（D-49 で D-38 の resource authorizer に統一）。遷移時に `emails.status` を `pending_reply_approval` に戻し、`timeline_events: cal_cancelled` を記録する（D-34）
- **worker 結果確定後の終端遷移（D-48）**: 全 attendee 成功 → `executed`。partial_failed → `executed_with_failures`（クレーム保持者/個人 owner に手動補正カード）。実行直前再検証（D-40）で競合検出 → operation を `replan_required` で終了し、proposal を `superseded` + 新 revision 自動生成（Flow 5 合流・`timeline_events: cal_replan_required`）。business failure での全失敗 → `manual_review_required`。result_unknown → reconcile 完了まで `execution_pending` を維持し運用 alert を発報する。`execution_pending` への永久滞留を許容しない

---

### proposal_approvals（NEW）

**用途**: スケジュール調整案に対する参加者ごとの承認状態・approvalToken を管理する。`calendar_proposals` の単一承認トークン設計をマルチユーザー対応に置き換える（C-13 / D-19）。

**主なカラム**:

| カラム名 | 型 | 制約 | 説明 |
|---|---|---|---|
| `id` | UUID | PK | |
| `proposal_id` | UUID | FK(calendar_proposals) NOT NULL | 対象 proposal |
| `attendee_ref` | TEXT | NOT NULL | 参加者の疑似識別子（users 登録時に生成された不変のサロゲート ID。D-33）。PII は保存しない |
| `google_subject_hash` | TEXT | NOT NULL | 参加者 Google subject の SHA-256 ハッシュ。承認操作者の確認に使用 |
| `status` | TEXT | NOT NULL DEFAULT 'pending' | `pending`（未回答）/ `approved`（承認済み）/ `rejected`（拒否済み） |
| `approval_token_hash` | TEXT | | SHA-256(plaintext_token)。平文は GET /v1/calendar/proposals/{id} レスポンスでのみ返す |
| `card_version` | INTEGER | NOT NULL DEFAULT 1 | stale card 検出用バージョン |
| `token_expires_at` | TIMESTAMPTZ | | approvalToken 有効期限（生成時から 72h） |
| `rejection_reason_code` | TEXT | | 拒否理由の非 PII コード |
| `rejection_reason_detail` | TEXT | | HUD 拒否フォームのマスク済み理由メモ。メールアドレス・URL・token を除去し、event_inbox / log には出さない |
| `rejected_slot_ids` | JSONB | | 拒否者が避けたい候補 slotId 配列（最大3件） |
| `preferred_windows` | JSONB | | 拒否者が入力した都合のよい時間帯（最大3件、start/endのみ） |
| `selected_slot_id` | TEXT | | 承認時に選択した候補 slotId。status=approved の場合は NOT NULL 相当 |
| `selected_slot_start` | TIMESTAMPTZ | | 承認時点で選択した slotStart のスナップショット |
| `selected_slot_end` | TIMESTAMPTZ | | 承認時点で選択した slotEnd のスナップショット |
| `created_at` | TIMESTAMPTZ | NOT NULL DEFAULT now() | |
| `updated_at` | TIMESTAMPTZ | NOT NULL DEFAULT now() | |

**インデックス**:
- `idx_proposal_approvals_proposal_id` — proposal 別参照（全参加者の集約確認）
- `idx_proposal_approvals_proposal_attendee` — UNIQUE（proposal_id, attendee_ref）

**制約**:
- `UNIQUE (proposal_id, attendee_ref)` — 同一参加者の二重登録防止
- `proposal_approvals_status_check`: status IN ('pending', 'approved', 'rejected')
- `proposal_approvals_selected_slot_check`: status != 'approved' OR (selected_slot_id IS NOT NULL AND selected_slot_start IS NOT NULL AND selected_slot_end IS NOT NULL)
- 承認/拒否時は `proposal_id` + `attendee_ref` + `google_subject_hash` + `card_version` + `token_expires_at` + `approval_token_hash` を検証する
- 他参加者（google_subject_hash 不一致）による操作は 403 とする

**FK 削除制約:**
- `proposal_id → calendar_proposals(proposal_id)`: ON DELETE CASCADE

**特記事項:**
- 通常 proposal 生成時に HUD 承認可能な参加者全員分の行を INSERT する（status=pending, 新 approvalToken 発行）。管理外必須参加者がいる `manual_review_required` proposal では、管理外参加者には approvalToken 行を作成せず `manual_confirmation_prompt` の確認対象として保持する
- 本テーブルは **append-only**（D-32）。代替案生成（alternatives API / internal replanner）時は旧 proposal の行を UPDATE せず、新 revision の proposal_id に対して全参加者分の行を新規 INSERT する（status=pending, 新 approvalToken 発行）。旧行は監査履歴・拒否入力（rejected_slot_ids / preferred_windows）として不変のまま保持し、replanner が `parent_proposal_id` チェーンを遡って累積参照する（D-20 / D-32）
- 候補0件（slots=[]）の revision には行を作成しない（proposal は `manual_review_required` に直行。D-34）
- Approval aggregator が全行を確認し、全員 approved かつ全員の `selected_slot_id` が同一 → `calendar_proposals.aggregate_approval_status = all_approved`、1行でも rejected → `any_rejected`、approved 行間に異なる `selected_slot_id` が2つ以上存在した時点（全員の回答を待たない）→ `selection_conflict` に即時更新する（OQ-MULTI-004 / D-35）

---

### calendar_operations

**用途**: HUD 承認後の Calendar 更新操作の冪等状態管理。operation_id で重複実行を防ぎ、承認された操作内容を暗号化した不変 plan として固定する。

**主なカラム**:

| カラム名 | 型 | 制約 | 説明 |
|---|---|---|---|
| `operation_id` | TEXT | PK | sha256(mailId+proposalId+selectedSlotId+slotStart+slotEnd+attendeeRefs+approvalSubjectHash) から生成する決定的ID |
| `proposal_id` | UUID | FK(calendar_proposals) NOT NULL | |
| `mail_id` | UUID | FK(emails) NOT NULL | |
| `approver_user_id` | TEXT | NOT NULL | 承認者識別子。MVPでは `approval_subject_hash` と同等の疑似識別子のみを保存し、HUD/API/監査には出さない。氏名・OSユーザー名・メールなどPIIは保存しない（OQ-DB-002 / OQ-SEC-004 CLOSED） |
| `selected_slot_start` | TIMESTAMPTZ | NOT NULL | 承認されたスロット開始 |
| `selected_slot_end` | TIMESTAMPTZ | NOT NULL | 承認されたスロット終了 |
| `execution_plan_envelope` | JSONB | NOT NULL | action、target、ETag、payload、slot、attendee_refを含む暗号封筒。reply draftと同じ必須メタデータを持つ |
| `plan_digest` | TEXT | NOT NULL | 復号後 canonical JSON の SHA-256。改ざん／異なる再実行を検出 |
| `availability_checked_at` | TIMESTAMPTZ | NOT NULL | plan 作成時の free/busy 確認時刻 |
| `status` | TEXT | NOT NULL DEFAULT 'dispatch_pending' | `dispatch_pending` / `in_progress` / `succeeded` / `partial_failed` / `failed` / `replan_required` / `result_unknown` |
| `manual_remediation_required` | BOOLEAN | NOT NULL DEFAULT false | 手動補正要フラグ |
| `correlation_id` | UUID | | エラー相関 ID |
| `created_at` | TIMESTAMPTZ | NOT NULL DEFAULT now() | |
| `updated_at` | TIMESTAMPTZ | NOT NULL DEFAULT now() | |

**インデックス**:
- `idx_calendar_operations_proposal_id` — 提案別参照
- `idx_calendar_operations_status` — 状態別参照

**制約**:
- `calendar_operations_status_check`: status IN ('dispatch_pending', 'in_progress', 'succeeded', 'partial_failed', 'failed', 'replan_required', 'result_unknown')
- `operation_id` は UNIQUE（重複 INSERT を防ぐ ON CONFLICT DO NOTHING または UPSERT）
- operation 作成と `outbox_events(calendar_operation_dispatch)` INSERT は同一 transaction で行う。Cloud Tasks enqueue 成功前に proposal を `executed` とみなさない
- worker は書込み直前に proposal revision、slot 時刻、free/busy、BU/allowlist、対象 event の version/ETag を再検証する。不一致は書込みなしで `replan_required`。create は operation marker、update/delete は `If-Match` 相当の version 条件で照合する

**FK 削除制約:**
- `mail_id → emails(id)`: ON DELETE RESTRICT（操作完了前のメール削除を禁止し、冪等管理（operation_id・status・attendee_ref単位の非PII結果）の整合性を保護するため）
- `proposal_id → calendar_proposals(proposal_id)`: ON DELETE RESTRICT（カレンダー操作が参照している提案の削除を禁止し、冪等性管理データの整合性を保護する）

---

### calendar_operation_results

**用途**: Calendar更新操作のattendee_ref単位結果を保存。attendee_ref/event_idは仮名化個人データとしてresource認可・retention対象にし、HUDへ内部eventIdは渡さない。

**主なカラム**:

| カラム名 | 型 | 制約 | 説明 |
|---|---|---|---|
| `id` | UUID | PK | |
| `operation_id` | TEXT | FK(calendar_operations) NOT NULL | |
| `attendee_ref` | TEXT | NOT NULL | 参加者の疑似識別子（users 登録時に生成された不変のサロゲート ID。D-33）。メールアドレス・表示名は保存しない |
| `status` | TEXT | NOT NULL | `succeeded` / `failed` / `skipped` |
| `event_id` | TEXT | | Google Calendar 内部 eventId（HUD には渡さない） |
| `error_code` | TEXT | | API エラーコード |
| `api_correlation_id` | TEXT | | Google API 相関 ID |
| `updated_at` | TIMESTAMPTZ | NOT NULL DEFAULT now() | |

**インデックス**:
- `idx_calendar_operation_results_operation_id` — 操作別参照

**制約**:
- `(operation_id, attendee_ref)` に UNIQUE 制約（UPSERT で冪等更新）
- `calendar_operation_results_status_check`: status IN ('succeeded', 'failed', 'skipped')

**FK 削除制約:**
- `operation_id → calendar_operations(operation_id)`: ON DELETE RESTRICT（操作の attendee_ref 単位の非PII結果が残存する状態で操作レコードを削除することを禁止し、結果の確認・アーカイブを先に完了させるため）

---

### faq_candidates

**用途**: AI が提案した FAQ 候補の本文を access-controlled domain table に保持し、永続通知 `event_inbox` には ID だけを渡す。

| カラム名 | 型 | 制約 | 説明 |
|---|---|---|---|
| `candidate_id` | UUID | PK | |
| `source_mail_id` | UUID | FK(emails) NOT NULL | 元メール |
| `content_envelope` | JSONB | NOT NULL | question/answerをまとめたAES-256-GCM暗号封筒 |
| `status` | TEXT | NOT NULL DEFAULT 'pending' | `pending` / `accepted` / `expired` |
| `created_at` | TIMESTAMPTZ | NOT NULL DEFAULT now() | |
| `expires_at` | TIMESTAMPTZ | NOT NULL | 未レビュー候補は30日で失効・削除 |

- 取得は source mail の owner／同一 BU resource authorization と FAQ 管理権限の両方を要求する。
- AI/RAG コンテンツを信頼済み命令として扱わず、PII review 完了後にだけ `faq_entries` へ昇格する。

---

### faq_entries

**用途**: HUD から登録した FAQ ナレッジ。pgvector 埋め込みで意味的検索を実現する。PII 除去確認済みコンテンツのみ保存。

**主なカラム**:

| カラム名 | 型 | 制約 | 説明 |
|---|---|---|---|
| `id` | UUID | PK | |
| `question` | TEXT | NOT NULL | FAQ 質問文（PII 除去済み） |
| `answer` | TEXT | NOT NULL | FAQ 回答文（PII 除去済み） |
| `category` | TEXT | | FAQ 分類 |
| `source_mail_id` | UUID | FK(emails) NULL | 元メール ID（任意） |
| `pii_reviewed` | BOOLEAN | NOT NULL DEFAULT false | HUD での PII 除去確認済みフラグ |
| `embedding` | vector(768) | | pgvector 埋め込みベクトル（Gemini text-embedding-004、768次元） |
| `is_active` | BOOLEAN | NOT NULL DEFAULT true | FAQ無効化（soft delete）フラグ |
| `disabled_at` | TIMESTAMPTZ | | 無効化日時 |
| `created_by_attendee_ref` | TEXT | NOT NULL | 登録者のランダム疑似ID。OSユーザー名・email・表示名は保存しない |
| `created_at` | TIMESTAMPTZ | NOT NULL DEFAULT now() | |
| `updated_at` | TIMESTAMPTZ | NOT NULL DEFAULT now() | |

**インデックス**:
- `idx_faq_entries_embedding` — HNSW（`vector_cosine_ops`, `m=16`, `ef_construction=64`）pgvector インデックス。`is_active=true` のFAQのみ検索対象
- `idx_faq_entries_category` — カテゴリ別参照
- `idx_faq_entries_active` — WHERE is_active = true

**pii_reviewed = false のレコードは /v1/faqs エンドポイントが拒否するため、Cloud SQL レベルでは強制しない**（アプリ層で保証）。

**FK 削除制約:**
- `source_mail_id → emails(id)`: ON DELETE SET NULL（FAQ は独立したナレッジとして保持するため、ソースメール削除後も FAQ レコードは有効のまま維持する。NULL 許容カラムのため SET NULL で整合性を維持する）

---

### sent_reply_embeddings

**用途**: 送信済み返信履歴を匿名化したうえで pgvector 埋め込みし、RAG コンテキストとして活用する。

**主なカラム**:

| カラム名 | 型 | 制約 | 説明 |
|---|---|---|---|
| `id` | UUID | PK | |
| `mail_id` | UUID | FK(emails) NOT NULL | 元メール ID |
| `anonymized_text` | TEXT | | `[REDACTED_EMAIL]` / `[PERSON_N]` 置換済みテキスト。90日後にクリアされるため NULL 許容 |
| `embedding` | vector(768) | | pgvector 埋め込みベクトル |
| `pii_masked_at` | TIMESTAMPTZ | | retention job による匿名化テキストクリア完了時刻 |
| `created_at` | TIMESTAMPTZ | NOT NULL DEFAULT now() | |

**インデックス**:
- `idx_sent_reply_embeddings_embedding` — HNSW（`vector_cosine_ops`, `m=16`, `ef_construction=64`）pgvector インデックス。`faq_entries` と同一パラメータ（データ量 <= 10,000件前提、REQ-STORE-003）
- `idx_sent_reply_embeddings_mail_id` — メール別参照

**FK 削除制約:**
- `mail_id → emails(id)`: ON DELETE RESTRICT（本システムではメールの物理削除は行わず PII マスクで対応するため、RESTRICT で整合性を保護する。万一削除が必要な場合は sent_reply_embeddings を先に削除または SET NULL 化する）

---

### settings_revisions

**用途**: 認可以外のOpenClaw設定を改版単位で保存し、管理者の同時更新を検出する。

| カラム名 | 型 | 制約 | 説明 |
|---|---|---|---|
| `revision` | BIGINT | PK, > 0 | 単調増加する設定版 |
| `value` | JSONB | NOT NULL | OpenAPI `OpenClawSettingsUpdate` 準拠。BU/所属は含めない |
| `created_by` | TEXT | NOT NULL | Admin SA email |
| `created_at` | TIMESTAMPTZ | NOT NULL | 作成日時 |

- GETは最新revisionと内容からstrong ETagを生成する。PUTは必須`If-Match`が最新ETagと一致する場合だけ次revisionをINSERTする。
- BUと所属は `business_units` / `business_unit_memberships` から読取専用projectionとしてGETレスポンスへ合成する。
- `dwdAllowlistEmails` 欠落・nullは空配列へ正規化し、DwD書込みをfail-closedにする。
- `holidayMode=configured_holiday_calendar` の場合は `holidayCalendarRef` を必須とする。

---

## pgvector 設計

### 拡張有効化

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

### 埋め込みベクトル次元数

Gemini API `models/text-embedding-004` の出力次元数 768 を正とし、`vector(768)` を正式採用する。別のembeddingモデルへ変更する場合のみ migration でカラム再定義・再embedding・インデックス再構築を行う。

### インデックス種別の選択

| 条件 | 推奨インデックス |
|---|---|
| FAQ 件数 <= 10,000件（REQ-STORE-003 前提）| HNSW（`m=16, ef_construction=64`）|
| クエリレイテンシ優先 | HNSW |
| 構築時間・メモリ優先 | 将来検討として IVFFlat |

現行 migration DDL は HNSW + `vector_cosine_ops` を採用する。件数・メモリ使用量が増加した場合のみ IVFFlat への切り替えを検討する。

**各テーブルのインデックス採用状況**:

| テーブル | カラム | インデックス種別 | パラメータ | 根拠 |
|---|---|---|---|---|
| `faq_entries` | `embedding` | HNSW | `m=16, ef_construction=64` | データ量 <= 10,000件、クエリレイテンシ優先 |
| `sent_reply_embeddings` | `embedding` | HNSW | `m=16, ef_construction=64` | `faq_entries` と同一の件数前提（REQ-STORE-003）、設計統一 |

### pgvector フォールバック

pgvector 不可時は Cloud SQL FTS（pg_trgm）キーワード検索にフォールバックする（REQ-FAQ-002）。

---

## advisory lock 設計

PostgreSQL `pg_try_advisory_lock(namespace, key)` を使用する。

| namespace | 用途 | キー |
|---|---|---|
| `1` | Gmail polling 排他制御 | `hashtext(mailbox_ref)`（mailbox ごと。Scheduler coordinator 自体は別の短期 lease で多重起動を抑止） |
| `2` | Calendar operation 排他制御 | `hashtext(operation_id)`（操作ごと） |
| `3` | PII retention job 多重実行防止 | `1001`（固定値） |
| `4` | BU 共有メール承認操作排他制御（Gmail 送信・クレーム移譲直前） | `hashtext(mailId)`（メールごと） |

第1引数を namespace として固定することで、Gmail polling、Calendar operation、PII retention job、メール承認操作のロックが衝突しない（REQ-DEPLOY-004）。

**取得ポリシー（A-1 / D-36）**:
- 全て `pg_try_advisory_lock`（非ブロッキング）で取得する。mailbox／operation 単位の取得失敗はその対象だけを skipped とし、他対象の処理は継続する。ブロッキング待機は行わない。
- クラッシュ時の解放は PostgreSQL のセッション断自動解放（advisory lock はセッション = DB 接続に紐づく）に依拠する。lock 保持中は専用接続を占有し、処理完了時に `pg_advisory_unlock` で明示解放する。
- 保険として Cloud SQL に `idle_in_transaction_session_timeout`（例: 10分）を設定し、ゾンビ接続を強制切断する（設定値の正本は Terraform）。

---

## 削除・保持ポリシー

| テーブル | ポリシー |
|---|---|
| `emails` | 受信から90日後にPII項目をマスクする。`reply_draft_envelope`・`approval_token_envelope`・token hash・draft_idはメール解決から90日後に削除する。レコード自体は保持 |
| `mailbox_poll_state` | mailbox が active な間保持。無効化から90日後に削除 |
| `mail_send_operations` | `reply_draft_ciphertext` は持たない。非PII operation/result は監査上1年保持し、Gmail ID は90日後に keyed hash へ置換 |
| `timeline_events` | 対応するメールの PII マスク後も保持（監査目的）。DELETE は禁止 |
| `event_inbox` / `event_inbox_recipients` | 全recipient ACK後7日、またはACK状態に関係なく作成30日後のhard TTLで物理削除。offboardingしたrecipientはFK cascadeで解消する |
| `outbox_events` | dispatched から30日後に削除。dead_letter は解決後30日、未解決はalert対象として保持 |
| `calendar_proposals` | `slots[].participantContexts` と `manual_confirmation_prompt` は予定タイトル・マスク済み予定本文・参加者表示名を含み得るため、受信から90日後に本文・表示名・参加者名を再マスクまたはクリアする。`slotId`、日時、rank、scoreReasonCodes、candidateLimitReason、aggregate_approval_status など非PII制御項目は保持する |
| `calendar_operations` / `calendar_operation_results` | execution plan暗号文とevent_idは90日後に削除／keyed hash化する。operation_id・status・reason codeは保持し、attendee_ref等の疑似IDはresource認可対象として扱う |
| `proposal_approvals` | `rejection_reason_detail`（マスク済み自由文）は90日後にクリアする。`rejection_reason_code`・`rejected_slot_ids`・`preferred_windows`・`selected_slot_*` は非PII制御項目として保持する（append-only 行にも適用。D-51） |
| `faq_entries` | 無効化（soft delete: `is_active=false`, `disabled_at` 記録）のみ。物理削除は手動管理者操作のみ |
| `faq_candidates` | pending_review は30日で暗号文を物理削除。accepted/rejected は本文を削除し非PII状態のみ90日保持 |
| `sent_reply_embeddings` | 受信から90日後に匿名化textとembeddingを削除する。保持例外は法務承認と再生成不能性の記録を必要とする |
| `settings_revisions` | 追記型。過去revisionは1年保持後に最新・監査digestを除き削除可能 |

---

## マイグレーション方針

- マイグレーションスクリプトは `migrations/` ディレクトリで連番管理（例: `001_initial_schema.sql`）
- 後方互換性を維持し、カラム追加は DEFAULT 値付きで行う（REQ-STORE-002）
- カラム名変更・削除は廃止予告 1リリース後に実施
- ロールバックスクリプトを必ずペアで用意する
- 旧SQLiteからの移行は、旧schema対応表、dry-run、テーブル別件数照合、主要テーブルchecksum照合、移行前暗号化バックアップ、失敗時rollback/再試行手順を必須とする（RC-MIG-001）
- checksum対象は少なくとも `emails`、`timeline_events`、`faq_entries`、`sent_reply_embeddings` とする。PIIマスク済みデータは移行可、90日超の生PIIは移行対象外または移行前マスク必須とする。移行前SQLiteバックアップは `~/.openclaw/backup/<timestamp>.sqlite.enc` として暗号化し7日で削除する。180日保持・保持例外は法務承認後のみ再OPENする

---

## 未確定事項

| ID | 優先度 | 内容 | 影響テーブル |
|---|---|---|---|
| OQ-DB-001 | Medium | **[CLOSED: 2026-06-02]** pgvector 埋め込みベクトル次元数: AIモデルを Gemini API（text-embedding-004）に確定。出力次元数は768次元。`vector(768)` の定義を正式採用する | faq_entries、sent_reply_embeddings |
| OQ-DB-002 | **[CLOSED: 2026-06-04]** | emails の PII 保持期間はMVP既定90日。180日保持・保持例外は法務承認後のみ再OPENする。Cloud SQLバックアップ7日分に残るPIIは暗号化・IAM制限・保持期間明記で対応する | emails、sent_reply_embeddings、calendar_proposals、calendar_operations、calendar_operation_results |
| OQ-DB-003 | **[CLOSED: 2026-06-04]** | 追記専用 `timeline_events` とPII retentionの衝突: MVP は `operator` / `detail` をPII非保持に固定し、operationId・status・correlationId・非PII skip reason・errorCode・exceptionClass の allowlist のみ保存する。raw エラーメッセージと stack trace は保存しない。保持例外は法務承認後のみ再OPENする | timeline_events |
| OQ-DB-004 | [CLOSED] | Cloud Scheduler の `/internal/retention/pii-mask` ジョブ拡張（案A）で対応。advisory lock namespace=3 を共有し、全 recipient 行 ACK 済みかつ最後の `acked_at` から7日超の event_inbox レコードを同一ジョブ内で物理削除する。2026-06-03 確定 | event_inbox、event_inbox_recipients |
| OQ-DB-005 | Low | JSONB カラム（`emails.participants`・`emails.proposed_datetimes`・`calendar_proposals.conflict_info`・`calendar_proposals.slots`・`event_inbox.payload`）への GIN インデックス必要性の評価。MVP 時点（約20件/日）ではフルスキャンで十分なため意図的に未作成。JSONB 要素を WHERE 条件とするクエリが追加された場合またはデータ量が増加した場合に追加を検討する。 | emails、calendar_proposals、event_inbox |
| OQ-DB-006 | **[CLOSED: 2026-06-04]** | `approval_token` の保存方式: RC-TOKEN-001-HASH 確定。SHA-256 ハッシュのみ DB 保存・プレーンテキストは HUD への認証済みカード取得レスポンスのみ・event_inbox payload 非保持・単回使用・mailId/proposalId/承認者userId/cardVersion/token_expires_at バインド。カラム説明を本書に反映済み | emails、calendar_proposals |
| OQ-RC-005 | — | **[CLOSED / SUPERSEDED]** proposalに`rejected`は持たず、participant拒否はaggregate=`any_rejected`、旧proposal=`superseded`、新revision作成で表す。現行CHECKは本文を正とする | calendar_proposals |

---

## 関連文書

| 文書名 | パス | ステータス |
|---|---|---|
| 要件定義書 | `requirements_definition.md` | Back 正本 |
| 処理フロー設計 | `process_flow_design.md` | Back 正本 |
| インターフェースコントラクト | `design.md` | Back 正本 |
| インフラアーキテクチャ設計 | `OpenclawSecretary-Terraform/docs/specs/infra/infra_architecture_design.md` | Terraform 正本 |
| セキュリティ設計 | `../../security/security_design.md` | Back application security 正本 |
| OpenAPI 正本 | `../../api/openapi.yaml` | Back 正本 |

## 展開済み補助文書

| 文書名 | パス | 用途 |
|---|---|---|
| カラム一覧 | `docs/specs/gmail-ai-secretary/db_columns_list_with_relations.md` | 本書のテーブル・FK・indexを一覧化して実装/移行時に参照する |
| ER 図 | `docs/specs/gmail-ai-secretary/er_diagram.md` | 本書のリレーションを図示し、削除制約と参照方向を確認する |
