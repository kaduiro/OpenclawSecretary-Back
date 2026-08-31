# セキュリティ設計書（Backend Application）

## 実装同期状況（2026-07-20）

実装済みの認証・認可・secret保管・暗号化・監査・retentionは[現行実装ベースライン](../implementation/current-implementation.md)を基準とする。本書のDomain-wide Delegation、AI/RAG境界、全scope構成、nonce fail-closed、raw caller ID除去、インフラalertは目標設計を含む。

重要な差分として、現在のOAuth同意scopeは`openid email gmail.modify`であり、本書が要求するCalendar scopeを含まない。Calendarを実環境で有効化する前に、正式scopeの確定、provider設定、既存利用者の再同意、返却scopeのfail-closed検証が必要である。また、refresh tokenの実装上のSecret Manager resource名は`openclaw-refresh-{attendeeRef}`であり、本文中の`refresh-token/{attendee_ref}`は論理命名である。

作成日: 2026-06-25 | 更新日: 2026-07-20 | ステータス: DRAFT

この文書は OpenclawSecretary-Back が保持するバックエンドアプリケーションセキュリティの正本である。Cloud Run、IAM、Secret Manager、Cloud Scheduler、Cloud Tasks、Cloud SQL などの現行リソース構成は `OpenclawSecretary-Terraform/docs/current/architecture.md` とTerraform HCLを正本とする。Terraformの`docs/legacy/`は現行判断に使用しない。

## 目的

- HUD / Gateway / private API 間の認証・認可をアプリケーション観点で定義する。
- Gmail / Google Calendar API 利用時の OAuth scope、token 取り扱い、Domain-wide Delegation のアプリケーション制御を定義する。
- Cloud SQL に保存する PII / Internal / Secret データの扱い、匿名化、保持、監査証跡を定義する。
- STRIDE 脅威に対するバックエンド実装上の防御策を定義する。

## 対象範囲

- HTTP API の認証 middleware
- OAuth confidential exchange と ID token refresh
- Gmail / Google Calendar API client
- Domain-wide Delegation allowlist 判定
- PII 匿名化、保持期限処理、監査イベント出力
- approvalToken の生成、保存、検証
- アプリケーションログ、`timeline_events` 出力

## 認証・認可

### HUD からの Google ID token

HUD は Google OAuth で取得した Google-signed ID token を `Authorization: Bearer` で送信する。バックエンドは次を検証する。

| 項目 | 設計 |
|---|---|
| issuer / signature / expiration | Google 公開鍵で検証し、期限切れ token は 401 とする |
| `aud` | `GOOGLE_CLIENT_ID` と完全一致させる。Cloud Run URL ではなく OAuth client ID を audience とする |
| `hd` | `ALLOWED_DOMAIN` と一致しない場合は 403 とする |
| `sub` | SHA-256(`sub`) を `users.google_subject_hash` と照合し、`provisioning_status=active` のみ許可する。未登録／provisioning中／pending_subject_bind／disabledは403（C-15 / D-37 / D-50）。BU ユーザーは初回ログイン時に ID token の `email` claim ハッシュを `pending_email_hash` と照合し、一致時のみ `google_subject_hash` を1回限りバインドする（`timeline_events: user_bound`。不一致・二重バインドは 403） |
| retry | 401/403 は即時エラーとし、資格情報を含む詳細を返さない |

マルチユーザーバックエンド（D-17）により、複数の参加者が同一バックエンドに接続する。`users` テーブルが認証の唯一の allowlist となり、fail-closed で扱う。`users` テーブルが空の場合はどのリクエストも 403 となる。

### OAuth confidential exchange / ID token refresh

Gateway callback → private `/internal/auth/exchange` は Gateway SA OIDC の専用経路であり、未登録 subject を通常 middleware に通さない。exchange 後の `/v1/auth/id-token/refresh` は active user の通常認証を要求する。

- HUD から refresh token、access token、authorization code、code verifier、OAuth client secret を受け取らない。
- `/v1/auth/start` の return_uri は `http://127.0.0.1:<1024-65535>/callback` または `http://[::1]:<port>/callback` の完全一致だけを許可する。localhost alias、userinfo、query、fragment、redirect追従、外部hostを拒否する。
- state、nonce、OAuth PKCE、完全一致return_uri、HUD生成handoff challenge、session expiryをserver-side sessionへbindする。callbackはloopbackへID token/claimsを送らず、60秒のrandom single-use handoffCodeと固定auth-bootstrap redeem URLだけをPOSTする。HUD mainが保持するverifierを限定公開auth-bootstrapへ提示し、専用Bootstrap SAでprivate redeemを呼び、一致時だけID tokenを返す。callback/handoffは`Cache-Control: no-store`、CSP、`Referrer-Policy: no-referrer`。
- OAuth client secret はアプリケーションレスポンス、ログ、Cloud SQL、renderer に出さない。
- ID token検証とBU共有アカウント重複確認後、userを`oauth_provisioning`で冪等作成してランダムattendee_refを確定する。その後refresh tokenをSecret Managerへ保存し、成功後だけactive化する。失敗時は再実行可能なprovisioning行として回復し、通常API権限は与えない。
- loopback handoff payloadはopaque `handoffCode`だけに限定する。ID token、claims、bootstrap stateはverifier検証済みredeem responseでのみHUD mainへ返す。
- auth-bootstrapは`POST /v1/auth/handoff/redeem`以外を404とし、browser Origin、8 KiB超body、rate limit超過を拒否する。Bootstrap SAはprivate Backの同internal endpoint以外で拒否する。
- 同一 `sub` / client / domain の再交換は `bootstrap.completed=true` として安全に扱う。

現行差分: `src/providers/google-oauth-provider.js`はnonce claimが存在する場合の不一致だけを拒否し、claim欠落を許容する。この節のnonce bindを満たすには、claim欠落も拒否し、provider単位のnegative testを追加する必要がある（`CR-AUTH-001`）。

### Service account からの内部／管理呼び出し

バックエンドは Cloud Scheduler / Cloud Tasks が付与する OIDC token を、HUD 向け `googleIdToken` とは別の security scheme として扱う。

| 呼び出し元 | アプリケーション検証 |
|---|---|
| Cloud Scheduler | issuer、expiration、audience、Scheduler 専用 service account email を検証する |
| Cloud Tasks | issuer、expiration、audience、Tasks 専用 service account email を検証する |
| Gateway | issuer、expiration、private API audience、Gateway専用 service account email を検証する。exchange以外のinternal endpointは拒否する |
| Admin | issuer、expiration、admin audience、Admin専用 service account email を検証する。settings/admin users以外は権限を付与しない |

各schemeは専用audienceと完全一致email allowlistをfail-closedで持ち、Gateway/Scheduler/Tasks/Admin/runtime SAの相互利用と一般ユーザーtokenを拒否する。

### Resource authorization

| Resource / command | 許可条件 |
|---|---|
| 個人 mail / ticket / detail / approve / reject | `emails.owner_attendee_ref == caller.attendee_ref` |
| BU mail metadata / claim | callerが当該BUのactive member。claimは未claim行へのconditional updateのみ |
| BU mail body/draft/token / approve / reject / reissue | callerが同一BUのcurrent claimant |
| claim transfer | transfer元=current claimant、transfer先=同一BU active member。完了時に旧tokenを失効 |
| Calendar proposal | source mail owner、同一BU current claimant、または自分の`proposal_approvals`行に必要な範囲のみ |
| Calendar operation status | 起票したpersonal ownerまたは同一BU active member。attendee email/provider IDは返さない |
| settings / admin users | Admin SA schemeのみ。一般HUD、Gateway、Scheduler、Tasks SAは拒否 |

認証後、token/card version照合より先にこの認可を評価する。resource境界外は存在確認を防ぐため404、同一resource内で権限不足のcommandは403、状態競合は409に正規化する。全queryはresource predicateをSQLへ含め、ID取得後のアプリ側判定だけに依存しない。

## Google API scope

| API | scope | 利用方式 | 方針 |
|---|---|---|---|
| Gmail | `gmail.readonly`, `gmail.compose` | BU 共有アカウント: DwD impersonation / 個人アカウント: OAuth refresh token（D-21） | `gmail.send` は採用しない。送信確定はユーザー承認後の compose / draft 操作に限定する |
| Calendar events | `calendar.events` | BU 共有: DwD / 個人: OAuth refresh token | events list/get/create/update/delete と ETag/version 再検証に使用 |
| Calendar free/busy | `calendar.events.freebusy` | BU 共有: DwD / 個人: OAuth refresh token | freeBusy query専用。busy intervalしか返らないため、予定タイトル等が必要なDwD pathではevents scopeを別途使う |
| OIDC | `openid`, `email` | 個人アカウント OAuth consent のみ | ID tokenとemail claim取得。`hd`だけでなくdomainを検証する |

refresh token は Secret Manager にのみ保存し、バックエンドの DB、ログ、API レスポンスには保存しない。

## Calendar Domain-wide Delegation

DwD はバックエンド実行 service account から IAM Credentials API `signJwt` を呼び出して実現する。service account key JSON は発行・保存・配布しない。`signJwt` 権限付与、custom role、対象 resource は Terraform 正本で管理する。

### 組織構造の前提（D-14 / D-21）

事業部ごとの共有 Workspace アカウントを Gmail/Calendar に使用する。DwD と個人 OAuth は `gmail.readonly + gmail.compose + calendar.events + calendar.events.freebusy` を用途別に利用し、freeBusyのbusy intervalとeventsの予定詳細を混同しない（D-39）。

### アプリケーション実装要件

- activeな `business_units` / `business_unit_memberships` が存在しない場合はfail-closedとし、Calendar events取得・書き込みを一切行わない。settings JSONは認可正本にしない。
- `businessUnits[].calendarAccount` が `dwdAllowlistEmails` に含まれるアカウントのみ DwD impersonation 対象とする。このアカウントは Gmail と Calendar の両方に DwD でアクセスする（D-21）。
- `businessUnits[].calendarAccount` に定義済みのアドレスは個人アカウントとして OAuth 自己登録できない。自己登録 API での重複検出は 409 で返す（C-16）。
- DwDで取得した事業部カレンダーのeventsには、activeな `business_unit_memberships.title_pattern` をliteral照合する。抽出した人名は即座に不変`attendee_ref`へ変換し、DB・ログ・event_inbox・timeline_eventsに保持しない。patternは最大200文字、同一BU内一意とし、曖昧一致は自動処理せずmanual reviewへ送る。
- `perUserSalt` は Secret Manager で管理し、アプリコード・環境変数・DB に含めない（`mailbox_ref = sha256(gmailAccount + perUserSalt)` の生成に使用を継続する。attendee_ref の生成には使用しない。D-33）。
- allowlist 対象外カレンダーアカウントへの書き込みは skip し、HUD には手動補正が必要な状態として返す。
- DwD 経由の書き込み結果は `timeline_events` に `operationId`、`status`、`correlationId` を記録する。
- Calendar 候補の認証済み card fetch API は、Electron main/openclaw-client にだけ承認操作用の plaintext approvalToken を短期返却できる。renderer IPC と HUD 画面表示には token を渡さない。HUD/API 表示データとしては予定タイトル、マスク済み予定本文、参加者表示名を返せるが、参加者メールアドレス、Google event id、calendar id、会議URL、OAuth token、approvalToken は表示・保存しない。表示名・イベントタイトル・予定本文は `event_inbox`、`timeline_events`、Cloud Logging には残さない。

## テナント分離

組織全体で1バックエンドを共有するマルチユーザーアーキテクチャ（D-17）を採用する。1 GCP project + 1 Cloud SQL instance で全参加者をカバーし、アプリケーションレイヤーで分離する。

| レイヤー | アプリケーション方針 |
|---|---|
| API | `users.google_subject_hash` DB 照合を必須にする。`ALLOWED_SUBJECT` 環境変数は廃止 |
| DB | `emails.mailbox_ref`（sha256(gmailAccount + perUserSalt)）でメールの受信 mailbox を識別する。`event_inbox_recipients.target_user_ref` で通知対象ユーザーとユーザー単位ACKを制御する。BU 共有メールは BU members 全員に、個人メールは本人のみに表示する（D-22）。`calendar_proposals` / `proposal_approvals` は参加者全員が参照可能だが承認操作は自分の `attendee_ref` に限定する |
| Secret | 個人 OAuth refresh token は `refresh-token/{attendee_ref}` で per-participant 管理。DwD / API key / client secret は組織共有 secret として扱う |
| 書き込み範囲 | 各参加者は自分の `proposal_approvals` 行のみ承認・拒否できる。他参加者の行への操作は 403 とする |

## データ分類

| 分類 | 定義 | 例 |
|---|---|---|
| PII | 個人を特定できる情報、または業務文脈で個人情報が混入しうる情報 | メールアドレス、氏名、メール本文、件名、要約、必要アクション、予定名 |
| Pseudonymous | 単独では氏名を示さないが、他データとの照合で個人へ結び付く情報 | attendee_ref、mailbox_ref、Gmail/Calendar provider ID、approval subject hash、embedding |
| Internal | 業務上の内部情報。個人とのリンクを持たない制御情報 | status、category、urgency、correlation_id、非PII reason code |
| Secret | 漏洩時に重大なリスクがある認証情報 | OAuth token、API key、client secret |

### テーブル別分類

| テーブル | PII | Internal |
|---|---|---|
| `emails` | `from_address`, `subject`, `body_preview`, `summary`, `actions`, `sender_intent`, `proposed_datetimes`, `participants` | `status`, `category`, `urgency`, `draft_id`, `approval_subject_hash` |
| `timeline_events` | 保存しない | `event_type`, 非 PII allowlist 済み `detail`, `correlation_id` |
| `calendar_proposals` | `slots[].participantContexts` と `manual_confirmation_prompt` に予定タイトル、マスク済み予定本文、参加者表示名を保存し得る。メールアドレス、Google event id、calendar id、会議URL、token は保存しない | `slotId`, `card_version`, `revision`, candidateLimitReason, aggregateApprovalStatus, 非 PII reason code |
| `calendar_operations` | execution plan暗号文はtarget/attendee/provider IDを含むためPII相当で保護 | `operation_id`, `status`, plan digest |
| `calendar_operation_results` | `attendee_ref`, `event_id` は仮名化個人データ | `status`, `error_code` |
| `mail_send_operations` | Gmail draft/message IDは仮名化個人データ | operation status、error code |
| `faq_candidates` | 暗号化question/answer | candidate ID、review status |
| `faq_entries` | `question`, `answer`, `embedding` は PII 除去確認済みのみ保存する | `created_by_attendee_ref` はPseudonymousとしてresource認可・retention対象にする |
| `sent_reply_embeddings` | 保存しない | `anonymized_text`, `embedding` |

## アプリケーション暗号化と鍵管理（D-51）

`emails.reply_draft_ciphertext`・`calendar_operations` の execution plan・`faq_candidates` の question/answer は Cloud KMS による envelope encryption で保護する。

| 項目 | 設計 |
|---|---|
| 鍵リソース | KeyRing / CryptoKey / IAM binding は **Terraform 正本**。Back は鍵リソース名を ENV で受領し、存在検証のみ行う |
| アクセス制御 | encrypt/decrypt（`cloudkms.cryptoKeyEncrypterDecrypter`）は Cloud Run 実行 SA のみ。HUD・Gateway SA・管理者個人アカウントには付与しない |
| rotation | 新 key version での暗号化を開始し、`*_key_version` カラムを使って読み取り時に段階的再暗号化する。旧 version は全行の再暗号化完了後に destroy する |
| 復号パス | resource 認可済みパス（detail API・Gmail 送信処理・Calendar worker・FAQ レビュー取得）のみ。復号結果を log / event_inbox / timeline_events / エラーレスポンスに出力しない |
| 鍵喪失時 | 暗号文は復元不能として扱う。reply_draft は再生成（BE-REQ-042 の draft 再作成）、execution plan は proposal を manual_review_required へ遷移して手動対応とする |
| DEK | envelope encryption の DEK は暗号文と同一カラムに wrapped 形式でのみ保存し、平文 DEK をメモリ外へ出さない |

## PII 匿名化

外部 AI API に RAG context を送信する前に、次の置換を実施する。

| 対象 | 置換形式 |
|---|---|
| メールアドレス | `[REDACTED_EMAIL]` |
| 氏名、固有名詞候補 | `[PERSON_N]` |

PII を含む原文は Cloud SQL の OpenClaw 管理領域にのみ保存し、外部 AI には送信しない。匿名化後text、疑似ID、provider ID、embeddingも匿名データとはみなさずPseudonymousとしてresource認可・保持・削除対象にする。

## AI / RAG 非信頼入力境界

- AI分析を有効化した環境では、メール原文を最初にGoogle Cloud DLPへ渡し、氏名、メールアドレス、電話番号、所在地、組織名、生年月日、カード番号、IBANを置換したtextだけをVertex AIへ送信する。DLPとVertex AIは同一GCP projectのruntime identityで呼び出し、API keyを使用しない。
- 既定modelはGemini 2.5 Flash-Liteとし、返信・日程調整が必要な場合または低信頼の場合だけGemini 2.5 Flashへ昇格する。`AI_ANALYSIS_ENABLED`は既定false、`GEMINI_DAILY_REQUEST_LIMIT`は組織全体の日次hard limitとしてDB transactionで適用する。
- system/developer instruction と、メール本文・予定本文・FAQ・RAG検索結果を構造的に別fieldへ渡す。外部text内の「命令」「tool call」「secret要求」はdataとして引用し、制御命令へ昇格させない。
- modelはGoogle API、DB、Secret Manager、HTTP toolを直接呼べない。副作用はversion付きJSON Schemaで検証済みdomain commandを、人間承認とresource authorization後にアプリケーションが実行する。
- model出力は`additionalProperties=false`、enum、length/count、日時範囲、attendee/slot allowlistで検証する。不正JSON、未知field、指示文混入、sanitizer marker改変は`analysis_status=failed`として手動対応へ送る。
- RAG documentはsource、active/reviewed状態、category、文字数をallowlistし、検索結果のdelimiterを固定する。FAQ候補はPII review前にactive RAG corpusへ入れない。
- model入力／出力本文を通常logへ出さない。評価用sampleは合成データのみとし、prompt injection、RAG poisoning、delimiter escape、PII sanitizer bypassをrelease gateに含める。
- Cloud Billing budgetは通知であり強制停止ではない。費用の強制境界はアプリケーションの日次request上限、Flash-Lite優先、Flash昇格条件、最大出力tokenで担保する。AI failure時は送信やCalendar操作へ進めず`manual_action_required`へフォールバックする。

## PII 保持・マスク

MVP の Cloud SQL 上の生 PII 保持期間は 90 日とする。180 日保持は法務承認済み文書が添付された場合のみ採用可能な上限候補であり、MVP 既定値ではない。

| 対象 | 90 日超過後の処理 |
|---|---|
| `emails.body_preview` | クリア |
| `emails.from_address`, `emails.participants` | マスク |
| `emails.subject`, `emails.summary`, `emails.actions`, `emails.sender_intent`, `emails.proposed_datetimes` | PII 検出結果に応じて再匿名化またはクリア |
| `sent_reply_embeddings` | 受信90日後に匿名化textとembeddingを削除。法務承認済み保持例外だけ期限と目的を別途記録する |
| Calendar proposal の予定表示情報 | 受信から90日後に `slots[].participantContexts` と `manual_confirmation_prompt` 内の予定本文・表示名・参加者名を再マスクまたはクリアする。slotId、日時、rank、scoreReasonCodes、candidateLimitReason、aggregateApprovalStatus は保持する |
| Calendar operation / result | execution plan暗号文とprovider IDは90日後に削除／keyed hash化し、operation id、status、revision、reason codeは保持する |
| `event_inbox` / recipients | 全recipient ACK後7日、または作成30日後のhard TTLで物理削除。未ACK滞留はalertし、offboarding時はrecipient FKを解消する |
| `faq_candidates` | 未レビュー暗号文は30日で削除 |
| `proposal_approvals.rejection_reason_detail` | マスク済み自由文のため90日後にクリアする。reason_code・rejected_slot_ids・preferred_windows・selected_slot_* は非PII制御項目として保持（append-only 行にも適用。D-51） |
| `emails.reply_draft_ciphertext` / `emails.draft_id` | メール解決（回答済み/解決済み/保留）から90日後に削除 / keyed hash 化する（D-51） |

保持期間処理は `/internal/retention/pii-mask` で実行する。対象件数、失敗件数、correlationId のみを Cloud Logging に出し、メール本文、件名、氏名などの PII は出力しない。

## approvalToken

| 項目 | 設計 |
|---|---|
| 生成 | `crypto.randomBytes(32).toString('hex')` で plaintext token を生成する |
| 有効期間 | 生成時から **72時間（259200秒）**。`token_expires_at = createdAt + 72h` で DB に保存する（OQ-TOKEN-001） |
| DB 保存 | SHA-256 hash のみ保存する。plaintext token は DB に保存しない |
| API 送信 | 認証済み card 取得レスポンスでのみ plaintext token を返す |
| event_inbox / log | plaintext token を保存しない |
| 検証 | HUD から受けた token を SHA-256 化して DB と照合し、現在の Google `sub` hash と `approval_subject_hash` を一致させる。`token_expires_at < now` の場合は 409 + `code: TOKEN_EXPIRED` を返す |
| 単回利用 | 承認または拒否後は `approved` / `rejected` に遷移し、再利用は 409 Conflict とする |
| binding | mailId または proposalId、承認者 Google subject hash、cardVersion、token_expires_at に紐付ける |
| 再発行 | `POST /v1/mail/{mailId}/reissue-token` または `POST /v1/calendar/proposals/{proposalId}/reissue-token` で新トークンを発行する。Calendar 版は `proposal_approvals` の呼び出し元 `attendee_ref` の行のみを更新する（他参加者の行は変更しない）。新 `crypto.randomBytes(32)` で生成し、`token_expires_at = now + 72h`・`card_version++` を更新する。旧トークン hash は上書きする（旧トークンは以降無効）。`timeline_events` に `token_reissued` イベントを記録する（OQ-TOKEN-002） |
| 再発行 PII | 再発行時も approvalToken 平文・参加者表示名・イベントタイトル・予定本文を log / event_inbox / timeline_events に出さない |
| Calendar 再発行 slot チェック | 再発行時に slot の `slotStart < now` を確認し、過去スロットが存在する場合は新トークンを返さず 200 + `slotExpired: true` を返して HUD に re-plan を促す。全 slot が有効な場合のみ透過的に新トークンを返す |
| per-participant 管理 | Calendar approvalToken は `proposal_approvals`（proposal_id, attendee_ref UNIQUE）で参加者ごとに管理する。`calendar_proposals` の単一 `approval_token` カラムは廃止。各参加者は GET /v1/calendar/proposals/{id} で自分の `attendee_ref` に紐づく token のみ受け取る（C-13） |
| BU共有mail | claim前はtokenを発行しない。claim transactionでclaimant subjectへbindして初回発行し、unclaim/timeout/transferで旧hashを失効する。current claimant以外へ平文token/draftを返さない（D-41） |

## 監査証跡

### timeline_events

バックエンドはメール操作、承認、拒否、Calendar 再提案、DwD skip / success / failure、保持期間処理の結果を `timeline_events` に追記する。

- append-only を原則とし、業務イベントの更新履歴を上書きしない。
- `operator` は null またはシステム識別子に限定する。
- `detail` は非 PII allowlist 済み field のみを許可する。Calendar 再提案では `proposalId`、`parentProposalId`、`revision`、`candidateLimitReason`、`rejectionReasonCode`、`status`、`correlationId` のみを許可する。
- `correlation_id` を必須にし、Cloud Logging と突合できるようにする。

### Cloud Logging

アプリケーションログは構造化 JSON とし、次を必須方針とする。

- token、authorization code、client secret、API key、メール本文、件名、氏名、メールアドレスを出力しない。
- error log は分類済み error code、operation id、correlation id、対象件数のみを出力する。
- 外部 API 失敗時も response body をそのまま出さない。

## STRIDE 脅威と対策

| 分類 | 脅威 | アプリケーション対策 |
|---|---|---|
| Spoofing | HUD を偽装した API 呼び出し | Google ID token の署名、`aud`, `hd`, `sub` 検証 |
| Spoofing | OAuth loopback redirect差し替え／handoff窃取 | numeric loopback、state/nonce/PKCE/return_uri bind、callbackはopaque codeのみ、HUD-held verifierでredeem、60秒単回、no-store/CSP |
| Tampering | approvalToken や cardVersion の改竄 | token hash 照合、subject hash binding、cardVersion check、単回利用 |
| Tampering | Calendar plan差し替え／stale write | encrypted immutable plan、digest、実行直前free/busy/revision/ETag再検証 |
| Repudiation | 承認・拒否操作の否認 | `timeline_events` と Cloud Logging の correlation id |
| Information Disclosure | PII / secret のログ漏洩 | 出力 allowlist、匿名化、token 非保存 |
| Information Disclosure | IDORで他mail/BU/operationを閲覧 | SQL resource predicate、owner/BU/claimant/participant認可、境界外404、no-store |
| Elevation of Privilege | DwD 対象外への Calendar 書き込み | fail-closed allowlist、organization domain check |
| Elevation of Privilege | Admin/Gateway/Scheduler/Tasks tokenの横流用 | schemeごとのaudience + SA email allowlistとendpoint allowlist |
| Elevation of Privilege | prompt injection / poisoned RAGで副作用起動 | 非信頼data分離、tool非公開、schema/allowlist検証、人間承認、resource再認可 |
| Denial of Service | 外部 API 失敗や 429 による再試行嵐 | bounded retry、429 backoff、Cloud Tasks max attempts は Terraform 側で制御 |

## 検証方法

- 認証 middleware unit test: `aud`, `hd`, `sub`, expired token、不正 issuer を検証する。
- confidential exchange test: response / log / DB に refresh token、access token、client secret が出ないことを検証する。
- OAuth bootstrap test: unknown subjectを通常APIは403、valid exchangeだけprovisioningできること、Secret書込み失敗から冪等回復すること、任意return_uri/再利用state/handoffを拒否することを検証する。
- resource authorization test: personal owner、同一BU非claimant、current claimant、別BU、disabled memberの一覧/detail/approve/transfer/operation statusを表駆動で検証する。
- service account matrix test: Admin/Gateway/Scheduler/Tasks/runtime SAを全internal/admin endpointへcross-callし、許可以外が拒否されることを検証する。
- DwD allowlist test: null / missing / empty / domain mismatch が fail-closed になることを検証する。
- approvalToken test: plaintext 非保存、hash 照合、subject hash mismatch、cardVersion mismatch、再利用 409 を検証する。
- PII log test: retention job、外部 API error、承認 API の log payload に PII / secret が混入しないことを検証する。
- OpenAPI security scheme test: HUD token と Scheduler / Tasks OIDC token を別 scheme として扱うことを検証する。
- AI adversarial test: prompt injection、RAG poisoning、delimiter escape、未知JSON field、PII sanitizer marker改変が副作用を起動せずmanual_action_requiredになることを検証する。

## 社内利用通知・ガバナンス（D-53）

本システムは従業員のメール・カレンダーを常時 AI 解析するため、技術的対策とは別に運用上の通知義務を定義する。

- 運用開始前に、対象従業員へ次を書面（社内規程・就業規則付属文書・社内ポータルのいずれか）で通知する: ① 解析対象（BU 共有 mailbox・登録済み個人 mailbox・カレンダー予定）② 目的(返信案生成・日程調整支援)③ 保持期間（生 PII 90日・監査メタデータ）④ AI への送信内容（PII 匿名化済みテキストのみ）⑤ 問い合わせ・オプトアウト窓口（個人 mailbox は登録解除可能。BU 共有 mailbox は業務システムとして扱う）。
- 通知文書の正本は本リポジトリ外（人事・法務管理）とし、本節は通知が満たすべき項目の定義のみを持つ。
- 30人規模の現組織では個別同意の取得までは要求しないが、組織拡大・派遣/業務委託メンバーの参加時に再評価する。

## 関連文書

- `OpenclawSecretary-Terraform/docs/security/security_design.md`
- `OpenclawSecretaryAndo/docs/MOVED.md`
