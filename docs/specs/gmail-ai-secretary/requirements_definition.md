# Backend Requirements: Gmail AI Secretary

## 実装との関係（2026-07-21）

本書は受入れ対象となる要件の正本であり、すべてが現時点で実装済みであることを示す文書ではない。実装済み・部分実装・未実装の判定は[現行実装ベースライン](../../implementation/current-implementation.md)と[検証報告](validation_report.md)を参照する。AIはDLP匿名化、Gemini分析、暗号化reply draft保存まで部分実装であり、承認可能Gmail draftへの接続、RAG、Calendar freeBusy planner、Domain-wide Delegation、全APIのresponse schema検証、rate limitingは残作業である。

作成日: 2026-06-25 | 更新日: 2026-07-21 (D-56 反映: 低コストPilot、Gmail Push、Gemini段階ルーティング) | ステータス: DRAFT

この文書は分割前 `OpenclawSecretaryAndo/docs/specs/gmail-ai-secretary/requirements_definition.md` から Back の責務だけを抽出した要件正本である。HUD UI は Front、Cloud Run / IAM / Secret Manager / Cloud SQL などのインフラ構成は Terraform を正本とする。

## Scope

- Gmail polling、メール分類、返信案生成、FAQ/RAG、Calendar 候補生成、Calendar operation 実行
- HUD / Gateway / private API が利用する REST API contract
- OAuth confidential exchange、ID token refresh、Google ID token / OIDC token のアプリケーション検証
- Cloud SQL に保存するドメインデータ、監査イベント、PII 保持・マスク
- Secret Manager を利用した refresh token / API key / client secret の参照。ただし secret resource と IAM binding は Terraform 管理

## Functional Requirements

| ID | 要件 |
|---|---|
| BE-REQ-001 | Cloud Scheduler から `/internal/poll-gmail` を受け、BU共有（DwD）とactiveな個人アカウント（OAuth）の新着を mailbox 別 History checkpoint、mailbox lock、bounded concurrency、continue-on-error で取り込む（D-23をD-44で更新） |
| BE-REQ-002 | メール本文を AI 分析し、カテゴリ、緊急度、返信要否、日程調整要否を判定する |
| BE-REQ-003 | RAG により返信案（replyDraft）を生成し、メール本文プレビュー（bodyPreview: 先頭500文字）・AI抽出タスク（actions）とともに HUD 承認待ちカード（MailApprovalCard）として取得可能にする。ユーザーはこの3点を HUD で確認した上で承認または拒否を選択する |
| BE-REQ-004 | HUD からの承認 / 拒否 API で `proposal_approvals` テーブルの per-participant approvalToken hash・cardVersion・google_subject_hash（attendee_ref に紐づく）を検証する。他参加者の行への操作は 403 とする（C-13 / D-19） |
| BE-REQ-005 | 承認後の Gmail 操作は重複送信を避け、自動リトライしない |
| BE-REQ-006 | Calendar 候補生成では、候補ごとに各参加者の前後予定を HUD に表示する。表示可能な情報は予定タイトル、予定本文/説明のマスク済み本文、参加者表示名とし、メールアドレス、Google event id、calendar id、会議URL、token は HUD/API/監査に露出しない |
| BE-REQ-007 | Calendar 書き込みは operation id と attendee ref 単位で結果を保存し、部分失敗を記録する |
| BE-REQ-008 | FAQ 候補は PII 除去確認後に保存し、embedding は Cloud SQL / pgvector に保持する。`POST /v1/faqs` は任意の `faqCandidateId` を受け、対応する `faq_candidates` 行を consumed に遷移する。明示 dismiss API は提供せず 30日自動削除で代替する（D-53） |
| BE-REQ-009 | event inbox は通知イベントのみを保持し、カード本文正本は `emails` などの domain table に置く |
| BE-REQ-010 | `timeline_events` と Cloud Logging に correlation id を出力し、PII / secret は出力しない |
| BE-REQ-011 | スケジュール変更依頼メールから対象期間、参加者（事業部・人数）、変更理由、制約条件を抽出し、抽出不能時は手動確認要として扱う。参加者の個人特定は activeなbusiness_unit_membershipsのtitle_pattern定義に委ね、メールテキストから直接個人メールアドレスを取得しない |
| BE-REQ-012 | Calendar空き時間の取得は2パスで行う。①DwDパス：business_unitsとactive membershipsから共有カレンダー・title_pattern・attendee_refを取得する。②OAuthパス：個人Workspace参加者のrefresh tokenでfreeBusyを取得する。外部識別子は即座にattendee_refへ変換し、両ソースから候補を最大3件生成する（D-18） |
| BE-REQ-013 | 各候補日時には安定した `slotId` を付与し、候補ごとに全参加者の設定済みcontext window内の予定コンテキスト（予定タイトル、マスク済み本文、予定時刻、参加者表示名）を認可済みdomain recordへ保存する。メールアドレス、Google event id、calendar id、会議URL、token はHUDへ返さない。各候補には `isWithinRequestedPeriod` と `periodLabel` を付ける |
| BE-REQ-014 | 既存予定の前後影響により優先度が下がる候補は順位を下げ、HUD へ rank と scoreReasonCodes を返す |
| BE-REQ-015 | 対象期間内で3候補を満たせない場合、候補不足理由と期間拡張・期間外候補・参加者調整・手動確認の代替案を返す。対象期間内に全員共通空きがない場合でも、期間外であることを `isWithinRequestedPeriod=false` / `periodLabel=outside_requested_period` / `scoreReasonCodes=outside_requested_period` で明示した候補を最大3件返せる。候補を1件も返せない場合は `slots=[]` とし `candidateLimitReason` を必ず返す |
| BE-REQ-016 | Calendar proposal 拒否時、HUD は拒否理由コード、任意のマスク済み理由メモ、避けたい `slotId`、任意の希望時間帯を入力できるフォームを表示する。拒否理由コードには `missing_participant`（AI が特定した参加者に漏れがある）を含め、proposal カードには AI が特定した参加者一覧（表示名）を常時表示して参加者抽出漏れに誰でも気づけるようにする。Back は1名でも拒否した時点で全員の回答完了を待たず `any_rejected` に遷移し、拒否者の入力、他参加者の既存回答、最新の Calendar 空き状況を使って revision を持つ新 proposal を作成する |
| BE-REQ-017 | 代替案生成時は旧 proposal を superseded に遷移させ、`timeline_events` に非 PII の `cal_replanned` / `cal_candidate_limited` / `cal_superseded` を記録する |
| BE-REQ-018 | HUD/API には候補判断に必要な予定タイトル、予定本文/説明のマスク済み本文、参加者表示名を返せる。ただしメールアドレス、Google event id、calendar id、会議URL、token、approvalToken 平文は renderer IPC、event_inbox、log、`timeline_events` に出力しない。`timeline_events` は reason code などの非PII要約のみを保存する |
| BE-REQ-019 | approvalToken の有効期間は生成時から 72 時間とする。HUD は card 取得時に `token_expires_at` を確認し、期限切れなら reissue-token API を自動で呼び出して新トークンを透過的に取得する。Back の reissue-token 処理では `proposal_approvals` の呼び出し元 attendee_ref 行のみを更新する（`token_expires_at = now + 72h`・`card_version++`）。Calendar 版は再発行時に slot の開始時刻が過去であれば `slotExpired: true` を返して HUD に re-plan を促す。オンライン復帰後はハートビート成功時点で即時ポーリングを 1 回実行する（OQ-TOKEN-001 / OQ-TOKEN-002 / OQ-RECONNECT-001） |
| BE-REQ-020 | マルチユーザー認証：通常APIはGoogle ID tokenの`sub` hashに対応する`users.provisioning_status=active`行だけを許可する。未登録／provisioning中／disabledは403。`ALLOWED_SUBJECT`は廃止する。未登録user作成はGateway SA認証済みexchange専用経路だけで行う（D-17 / D-37） |
| BE-REQ-021 | per-participant承認集約：全員approvedかつ同一selectedSlotIdの場合のみaggregate=all_approved、proposal=execution_pending、operation plan/outboxを同一transactionで一度だけ作成する。dispatcherがCloud Tasksへ配送し、全write成功確認後だけproposal=executed。slot割れは即selection_conflict、1名拒否は即any_rejected（D-35 / D-43） |
| BE-REQ-022 | 代替案生成（alternatives API / internal replanner）時は旧 proposal を superseded に遷移し、**新 revision（新 proposal_id）に対して全参加者分の `proposal_approvals` 行を新規 INSERT する**（status=pending、新 approvalToken 発行）。旧 proposal の行は不変のまま保持し（append-only）、監査履歴と拒否入力（rejected_slot_ids / preferred_windows）を残す。replanner は `parent_proposal_id` チェーンを遡って全 revision の拒否履歴を累積参照し、拒否済み slot を再提示しない（D-32）。全員が新しい候補を見て再投票する（D-20）。1名拒否・選択候補割れ・候補期限切れのいずれも同じ revision 再投票フローに入る |
| BE-REQ-023 | 個人 Workspace OAuth：HUD 初回起動時（または Gmail 自己登録時）の OAuth 同意フローで `openid` + `email` + `gmail.readonly` + `gmail.compose` + `calendar.events` + `calendar.events.freebusy` を一括取得し、refresh token を Secret Manager キー `refresh-token/{attendee_ref}` に保存する。`calendar.events.freebusy` は freeBusy API 用、`calendar.events` は予定詳細取得と書き込み用とする。⚠️ freeBusy 用スコープの正式名は Google の現行 granular scope 一覧（`calendar.freebusy` の可能性）と実装前に突合し、本要件・security_design・Terraform の3箇所を統一する（D-53 検証タスク）。既存ユーザーは次回 HUD 起動時に再 consent が発生する。個人 Gmail・Calendar の両アクセスをこの単一 refresh token で行い、DwD は使用しない（D-18 / D-21 / D-39） |
| BE-REQ-024 | メール拒否時は Gmail draft を削除し、resource認可済みレスポンスに`gmailMessageId`を含めてGmailへの手動返信導線を提供する。provider IDは仮名化個人データとして扱い、event_inbox/logへ出さず90日後に削除またはkeyed hash化する |
| BE-REQ-025 | Gmail 自己登録：OAuth exchange は Google ID token の署名・issuer・expiration・aud・hd を検証した後、BU 共有アドレスとの重複を検査し、個人ユーザーの `users` 行とランダム `attendee_ref` を先に作成してから `refresh-token/{attendee_ref}` を保存する。Secret 保存失敗時は `oauth_provisioning` 状態として再開可能にし、通常 API token は登録完了後にだけ返す。`POST /v1/auth/gmail-self-registration` は登録済み状態を冪等確認する API とし、未知の `sub` を通常認証middlewareで通す用途には使わない（D-24 / D-37） |
| BE-REQ-026 | マルチアカウント増分ポーリング：`/internal/poll-gmail` は `mailbox_poll_state.last_history_id` を利用して mailbox ごとに Gmail History API を増分取得し、期限切れ historyId は安全な full sync にフォールバックする。処理は mailbox 単位 advisory lock と設定可能な bounded concurrency で実行し、1アカウントの失敗を隔離する。重複判定は `(mailbox_ref, gmail_id)` とし、page token を最後まで処理してから checkpoint を更新する（D-23 / D-44） |
| BE-REQ-027 | per-mailbox可視性制御：`GET /v1/mail/pending` はownerまたはactiveな同一BU membershipをSQL resource predicateで検証し、本文・draft・tokenを含まない軽量ticketだけを返す。PII詳細はmail detailでオンデマンド取得する |
| BE-REQ-028 | BU ユーザー事前登録と subject bind-on-first-login：管理者は `POST /internal/admin/users`（IAP + Admin SA 限定）で `users` テーブルへ BU ユーザーの行を登録する。登録時に `attendee_ref`（**登録時にランダム生成される不変のサロゲート ID。`crypto.randomUUID()`。D-33**）・`pending_email_hash = sha256(組織メールアドレス)`・`workspace_access_type = 'business_unit_dwd'`・`provisioning_status = 'pending_subject_bind'` を設定する。**`google_subject_hash` は登録時には設定しない**（Google `sub` は本人初回ログインまで誰にも不明）。本人初回ログインで ID token（署名・`hd` 検証済み）の `email` claim ハッシュが `pending_email_hash` と一致した場合のみ `google_subject_hash` を1回限り確定し、`pending_email_hash` をクリアして `active` へ遷移、`timeline_events: user_bound` を記録する（D-50）。titlePattern / email は可変属性として管理し、「titlePattern → attendee_ref」の解決は lookup で行う。BU ユーザーによる自己選択・自動マッチングは禁止する（D-25 / C-18） |
| BE-REQ-029 | BU 共有メールのクレーム取得：未クレームの共有メールには approvalToken を発行せず、BU メンバーには token 非含有の summary のみ返す。`POST /v1/mail/{mailId}/claim` は caller が当該 mailbox の BU メンバーであることを検証し、claimer 設定・approval subject binding・新 token hash 発行・card_version 更新を1トランザクションで行う。成功後、現クレーム保持者だけが detail API から plaintext token を取得できる。承認・拒否・再発行は current claimant または個人 mailbox owner に限定する（D-26 / D-41） |
| BE-REQ-030 | クレーム解除は自分のclaimだけを解除し、claimer/claimed_atに加えてapproval subject/token hash/expiryをNULL化する。移譲は同一BU active memberへ限定し、旧token失効・target subject bind・新token発行・card_version++を1transactionで行う。event_inboxはmetadata-only通知（D-27 / D-41）。**強制引き取り（D-49）**: `pending_calendar` 中でも `claimed_at > 24時間` の場合に限り、同一 BU の active メンバーが自分宛 transfer を実行できる（保持者不在デッドロック解消）。通常 transfer と同じトークン再バインドを行い、`timeline_events: mail_force_claimed` を記録して event_inbox で BU 全員に通知する |
| BE-REQ-031 | 管理外参加者（社外参加者、AI秘書未導入で HUD 承認できない参加者、`users` に存在しない参加者）が必須参加者に含まれる場合、管理内参加者の空き状況だけで候補を作り、管理外参加者の availability は `unknown` として扱う。ただし Calendar 自動書き込みは行わず `calendar_proposals.status = manual_review_required` / `candidateLimitReason = external_manual_confirmation_required` として停止する。管理外参加者には `proposal_approvals` 行・approvalToken・event_inbox 通知を作成しない。HUD は**担当者（BU 共有メール = current claimant / 個人 mailbox = owner。D-49）**に確認依頼テキスト（メールアドレスを含まない候補日時・前後予定要約・確認依頼文）を表示し、MVP では外部確認後の自動再開を行わず、担当者が手動返信または手動予定変更で完了する。任意参加者の場合のみ、`reduce_required_attendees` を代替案として提示できる |
| BE-REQ-032 | proposal 手動キャンセル：`POST /v1/calendar/proposals/{proposalId}/cancel` の実行権限は **BU 共有メール = current claimant / 個人 mailbox = `emails.owner_attendee_ref`**（D-38 の resource authorizer と同一判定。D-49）とし、proposal を `cancelled` に遷移、全 `proposal_approvals` を無効化、`timeline_events: cal_cancelled` を記録し、`emails.status` を `pending_calendar` → `pending_reply_approval` に戻す。cancel 後は 2h クレームタイムアウトの適用対象に復帰する。保持者不在時は BE-REQ-030 の強制引き取り（24h 経過後）でクレームを取得してから cancel できる。cancel 後の返信はレスポンスの `gmailMessageId` を使った手動返信ナビゲーションへ誘導する（AI 返信案の再生成は v2）。未回答参加者の自動タイムアウトは MVP では提供しない（D-34 / OQ-MULTI-005 CLOSED） |
| BE-REQ-033 | superseded / cancelled proposal へのレース応答：旧 proposal（superseded / cancelled）に対する approve / reject / reissue-token は `409 + code: proposal_superseded + supersededByProposalId`（cancelled の場合は supersededByProposalId=null）を返す。HUD はこのレスポンスで新 proposal のカードへ自動遷移する。ほぼ同時の複数拒否では、2人目以降の拒否入力は新カード上で再入力する（D-35） |
| BE-REQ-034 | replan 終端保証：① replan の結果が候補0件（slots=[]）の場合、`proposal_approvals` を作成せず `status = manual_review_required` に直行して投票フェーズをスキップし、担当者（BU = current claimant / 個人 = owner。D-49）へ手動対応カード（候補不足理由 + 代替案）を表示する。② `revision >= 3` の proposal からは replan を行わず、`status = manual_review_required` / `candidateLimitReason = max_revisions_reached` に遷移させる（無限再投票ループ防止。D-34） |
| BE-REQ-035 | orphan draft 防止：Gmail draft 作成前に `emails` 行を `status='processing'` で先行 INSERT し、draft 作成成功後に `draft_id` を UPDATE する。クラッシュ回復は `processing` かつ `draft_id IS NULL` の行を次回ポーリングで検出し、Gmail `drafts.list` で同スレッドの既存 draft を再利用または再作成する（A-2 / D-36） |
| BE-REQ-036 | advisory lock は全て `pg_try_advisory_lock`（非ブロッキング）で取得し、取得失敗は `200 (skipped)` を即返却する（待機なし・タイムアウト定義不要）。クラッシュ時の解放は PostgreSQL のセッション断自動解放に依拠し、保険として Cloud SQL に `idle_in_transaction_session_timeout` を設定する（A-1 / D-36） |
| BE-REQ-037 | polling error：Gmail 429/quotaはmailbox checkpointを進めずRetry-Afterまたはbackoff+jitterでnext_attempt_atを設定し、他mailboxを継続する。AI timeout/schema不正は`analysis_status=failed`、replyDraft/tokenなしのmanual_action_required cardとして保存する（D-36 / D-44 / D-45） |
| BE-REQ-038 | 特殊メールの識別：① バウンスメール（`From: mailer-daemon@*` / `postmaster@*` または `Content-Type: multipart/report`）は AI 分析をスキップし、元メール（In-Reply-To で特定）の timeline に `mail_bounced` を記録して承認不要の通知カードを表示する（B-3）。② `In-Reply-To` が自送信 message-id と一致する返信メールは新規カードに「返信スレッド」ラベルを付与する（文脈統合 AI 分析は v2。B-2）。③ 承認時に Gmail draft が 404 の場合は `status='draft_missing'` に遷移し、HUD にエラー表示と replyDraft からの draft 再作成手段を提供する（B-4 / D-36） |
| BE-REQ-039 | OAuth handoff：numeric loopback callbackだけを許可し、sessionにreturn URI/state/nonce/OAuth PKCE/HUD handoff challenge/expiryをbindする。callbackはID token/claimsでなく60秒のsingle-use opaque codeと固定auth-bootstrap redeem URLだけをPOSTする。HUD mainが限定公開auth-bootstrapへverifierを提示し、専用Bootstrap SAでprivate redeemを呼んだ時だけID tokenを返す。auth-bootstrapはredeem以外を公開せず、body上限・rate limit・no-store・browser Origin拒否を適用する（D-37/D-55） |
| BE-REQ-040 | 管理者・リソース認可：settings更新とBUユーザー登録は専用 Admin SA OIDC scheme を要求する。一般APIは認証に加えて、mailbox membership、event recipient、current claimant、proposal participant、operation participant のいずれかをresource単位で検証する。推測されたIDによる越境アクセスは404、本人行以外の変更は403とする（D-38） |
| BE-REQ-041 | Calendar 実行計画：承認完了時に attendee ごとの action（create/update/delete/noop）、暗号化したtarget calendar/event reference、expected ETag、desired event payloadを operation plan として保存する。worker は書き込み直前にfreeBusyとETagを再検証し、競合時は外部書き込みを行わず `replan_required` に遷移する（D-40） |
| BE-REQ-042 | AI/draft状態：`emails` は `analysis_status`、`analysis_error_code`、暗号化した `reply_draft` と鍵versionを保持する。APIカードは `approval_ready` / `manual_action_required` / `bounce_notice` の判別可能なvariantとし、AI失敗時はreplyDraftとapprovalTokenを要求しない。draft 404時は暗号化draftから再作成する（D-42） |
| BE-REQ-043 | Gmail送信回復：承認transactionは`mail_send_operations=prepared`を作成し、`draft_created` / `sending` / `succeeded` / `result_unknown` / `failed_terminal`を記録する。結果不明はpendingへ戻さずprovider ID/operation markerでreconcileし、未送信確定時だけretryする（D-43） |
| BE-REQ-044 | Calendar dispatch回復：operation作成と同一DB transactionで `outbox_events` を作成し、dispatcherがCloud Tasksへ冪等enqueueする。workerはattendee別成功結果をskipできる冪等処理とし、transport failureは再試行、記録済みbusiness failureは2xxで終了する（D-43） |
| BE-REQ-045 | AI/RAG防御：メール本文、予定本文、FAQ候補、RAG検索結果を非信頼データとしてモデル命令から分離し、モデル出力をversion付きJSON Schemaとallowlistで検証する。外部入力からtool/APIを直接起動せず、prompt injection・RAG poisoning・PII sanitizer bypassをテストする（D-45） |
| BE-REQ-046 | PII/仮名化データ：subjectを含むticket/detailはresource認可とno-storeを適用する。疑似ID・provider ID・embeddingも保持/削除対象とする。event inboxは全recipient ACK後7日または作成30日hard TTL、embeddingは既定90日で削除する（D-45） |
| BE-REQ-047 | Scheduling policy：timezone解決規則、default duration、slot step、minimum notice、祝日・終日・透明予定・繰り返し予定・DST、候補同順位時の決定規則を設定として保持し、同じ入力から同じslotId/rankを生成する（D-46） |
| BE-REQ-048 | Calendar 実行結果の proposal 終端遷移（D-48）：worker 結果確定後、全 attendee 成功 → `executed`。partial_failed → `executed_with_failures`（担当者に手動補正カード）。実行直前再検証（D-40）の競合検出 → operation を `replan_required` で終了し proposal を `superseded` + 新 revision 自動生成（`timeline_events: cal_replan_required`）。business failure での全失敗 → `manual_review_required`。result_unknown → reconcile 完了まで `execution_pending` を維持し運用 alert を発報する。`execution_pending` への永久滞留を許容しない |
| BE-REQ-049 | replyDraft 確定日時再生成（D-52）：Branch B では `all_approved`（execution plan commit）遷移時に確定 slot 日時を差し込んで replyDraft を再生成・再暗号化し、`card_version++` して `pending_reply_approval` へ遷移する。AI 再生成失敗時は「確定日時のテンプレート文 + 元 draft 本文」にフォールバックし、最終確認は HUD 承認が担保する |
| BE-REQ-050 | 暗号化と鍵管理（D-51）：reply_draft / execution plan / faq_candidates の envelope encryption に使用する Cloud KMS の KeyRing / CryptoKey / IAM binding は Terraform 正本とし、Back は鍵リソース名を ENV で受領する。encrypt/decrypt 権限は Cloud Run 実行 SA のみに限定する。rotation は新 key version での暗号化開始 + `*_key_version` カラムによる段階的再暗号化で行う。復号は resource 認可済みパス（detail API・送信処理・Calendar worker）のみで実行し、復号結果を log / event_inbox / timeline_events に出力しない |
| BE-REQ-051 | 低コスト受信経路（D-56）：Gmail `users.watch` → Pub/Sub → 認証済み`POST /internal/gmail/notifications`を主経路とし、mailbox単位History checkpointで増分取得する。watchは日次更新し、通知欠落に備えた`/internal/poll-gmail`は1時間周期のフォールバックとして維持する。未知の通知先メールアドレスは保存・ログ出力せず無視する |
| BE-REQ-052 | AI費用境界（D-56）：AIはfeature flagで有効化し、Google Cloud DLPでPIIを匿名化したtextだけをGeminiへ送る。Flash-Liteを既定とし、返信・日程調整が必要または低信頼の場合だけFlashへ昇格する。組織単位の日次request hard limitと最大出力tokenを適用し、上限到達・匿名化失敗・model/schema失敗時は外部副作用を行わずmanual actionへ遷移する。Billing budget通知だけを強制上限として扱わない |

## API Contract

- OpenAPI 正本は `docs/api/openapi.yaml`。
- Front は Back の OpenAPI を生成 client または利用 contract として参照する。
- Scheduler / Tasks 内部 endpoint の security scheme は HUD 向け Google ID token と分離する。

## Data Requirements

- DB 正本は `db_design_document.md`（実装フェーズでは `migrations/*.sql` が最上位正本。D-30）。`er_diagram.md`・`db_columns_list_with_relations.md` は参考補助文書。
- **組織全体で1バックエンド + 1 Cloud SQL instance を共有する（D-17）**。テナント分離はアプリケーション層（`mailbox_ref`・`event_inbox_recipients`・`proposal_approvals` の attendee_ref 検証）で行い、RLS は不採用。
- PII 保持既定は 90 日。保持期限処理は `/internal/retention/pii-mask` で実行する。

## Non-Functional Requirements（SLO）

> D-56以後はGmail Pushを主経路とする。次のSLIはPush通知受信後の処理を測定し、1時間pollingは通知欠落時の回復経路として別管理する。

| SLI | 定義 | 目標 |
|---|---|---|
| SLI-01改 | ポーリング実行開始 → HUD カード取得可能 | p95 ≤ 60秒/アカウント |
| SLI-02 | 承認操作 → Gmail 送信完了 | p95 ≤ 15秒 |
| SLI-03 | Gmail watch更新とフォールバックpolling | watchは日次、pollingは1時間 ± Cloud Scheduler誤差 |
| 可用性 | `/readyz` 成功率 | 99.5%/月（MVP 水準） |

## Non-Goals

- HUD の画面、renderer / main process 境界、ユーザー操作 UI の詳細設計
- Terraform module、IAM binding、Cloud Run、Cloud SQL、Secret Manager resource の定義
- gcloud 手順書の正本管理
- 承認後の Gmail ラベル・アーカイブ同期（C-3。MVP 除外を明示）
- proposal 未回答の自動 stale 検出・自動キャンセル（v2。MVP は BE-REQ-032 の手動キャンセルのみ）
- 返信メールの文脈統合 AI 分析（v2。MVP は BE-REQ-038 のラベル付与のみ）

## Acceptance Criteria

- OpenAPI と Back docs が同じ endpoint / schema / security scheme を説明している。
- approvalToken 平文、OAuth token、client secret、メール本文 PII が DB / log / event inbox に漏れない。
- `GET /v1/mail/pending` のレスポンスに `bodyPreview`・`actions`・`replyDraft` がすべて含まれ、HUD でユーザーが内容を確認できる。
- Gmail 送信と Calendar 書き込みは HUD 承認後のみ実行される。
- メール拒否時は `RejectResponse.gmailMessageId` が常に返り、HUD が元メールを Gmail で開くことができる。`bodyPreview` および `replyDraft` が event_inbox / log に保存されていないことを確認する。
- 複数人スケジュール変更では、3候補または候補不足理由と代替案が返り、Calendar 書き込みは**全参加者が各自の HUD で同一 `selectedSlotId` を承認した後にのみ**実行される。1名でも拒否した場合、または全員承認でも選択候補が割れた場合は代替案フローへ遷移し Calendar 書き込みは実行されない。
- `users.google_subject_hash` に存在しない Google subject からのリクエストは 403 となる。`ALLOWED_SUBJECT` 環境変数への依存がコードに残らない。
- 各参加者は自分の `attendee_ref` に紐づく `proposal_approvals` 行のみ承認・拒否できる。他参加者の行への操作は 403 となる。
- 代替案生成時に旧 proposal の `proposal_approvals` 行が不変のまま残り、新 revision に status=pending の行が全参加者分 INSERT され、全参加者の event_inbox に新 proposal_ready が通知される。
- 各候補slotで、他参加者を含む全参加者の前後予定タイトル・マスク済み本文・参加者表示名が HUD に表示でき、メールアドレスが返却されないことを確認する。
- 対象期間内に全員共通空きがない場合、期間外候補は `isWithinRequestedPeriod=false` と `periodLabel=outside_requested_period` で明示され、候補0件の場合は `slots=[]` と候補不足理由が返ることを確認する。
- 事業部カレンダーのイベントタイトルから取得した人名は処理中のみ保持し、即座に attendee_ref へ変換する。人名が DB・ログ・event_inbox に残らないことを確認する。
- activeな business_units / memberships が存在しない状態でCalendar plannerが呼ばれた場合、候補生成を行わず candidateLimitReason: BUSINESS_UNITS_NOT_CONFIGURED として返す。
- 拒否済み proposal からの代替案生成では、新 revision が作成され、旧 proposal は superseded として監査される。
- `GET /v1/mail/pending` が認証済みユーザーのアクセス権のある mailbox のメールのみを返し、他ユーザーの個人メールが混在しないことを確認する。
- Gmail自己登録APIがactiveな `business_units.calendar_account` と重複するアドレスを検出した場合に409を返すことを確認する。
- スケジュール変更ありメールで `emails.status` が `pending_calendar` → `pending_reply_approval` → `回答済み` の順に遷移し、Calendar 承認完了前に返信が送信されないことを確認する。
- `pending_calendar` 中の BU 共有メールは、`claimed_at` が2時間を超えてもクレームが自動解除されず、Calendar 承認完了後の返信者がクレーム保持者として維持されることを確認する。
- 管理外必須参加者が含まれる場合、管理内参加者の空き状況だけで候補が作られ、proposal が `manual_review_required` で停止し、管理外参加者には approvalToken / event_inbox が発行されず、クレーム保持者向けの手動確認テキストが HUD に表示されることを確認する。
- BU 共有メールにクレームが存在する状態で別のメンバーがクレーム API を呼び出した場合に 409 が返ることを確認する。クレーム保持者が承認操作を実行した場合のみ Gmail 送信が行われることを確認する。
- `DELETE /v1/mail/{mailId}/claim` が自分のクレームのみ解除し、他人のクレームに対して 403 を返すことを確認する。
- `POST /v1/mail/{mailId}/transfer` が同一 BU メンバーへの移譲のみを許可し、異なる BU への移譲は 400 を返すことを確認する。
- superseded / cancelled proposal への承認・拒否操作が `409 + code: proposal_superseded` を返し、HUD が新 proposal のカードへ遷移できることを確認する。
- approved 行間に異なる selectedSlotId が2つ以上発生した時点で、残り参加者の回答を待たず `selection_conflict` に遷移することを確認する。
- クレーム保持者が cancel API を実行すると proposal が `cancelled` になり、`emails.status` が `pending_reply_approval` に戻り、2h クレームタイムアウトが再び適用されることを確認する。クレーム保持者以外の cancel は 403 となる。
- 代替案生成後も旧 proposal の `proposal_approvals` 行（選択 slot・拒否入力）が不変のまま残り、新 revision の候補に親チェーンの拒否済み slot が含まれないことを確認する。
- `revision >= 3` の proposal から replan が実行されず `manual_review_required` に遷移することを確認する。
- 未登録個人ユーザーのOAuth exchangeが、通常APIの403 allowlistを迂回せずにuser作成・attendee_ref発行・Secret保存を完了し、途中失敗から再開できることを確認する。
- OAuth return_uri がloopback以外、範囲外port、userinfo/fragment付きの場合に拒否され、handoffが単回使用であることを確認する。
- settings/admin APIが一般ユーザーtokenを拒否し、mail/detail/claim/proposal/operationが別BU・別mailboxのIDを404で隠すことを確認する。
- 個人CalendarのfreeBusyとevents取得が同意済みscopeで成功し、workerが実行直前の競合またはETag不一致を `replan_required` として書き込み前に停止することを確認する。
- Gmail送信の応答前クラッシュ、Calendar enqueue前クラッシュ、worker途中クラッシュから、outbox/reconcilerと冪等結果により重複副作用なしで回復できることを確認する。
- Gmail History APIの複数page、期限切れhistoryId、同一gmail_idの別mailboxを正しく処理し、checkpointが全page完了前に進まないことを確認する。
- prompt injection、RAG poisoning、PII sanitizer bypass入力がschema外出力や外部副作用を発生させないことを確認する。
- `pending_calendar` かつ `claimed_at > 24h` の BU 共有メールに対し、同一 BU の別メンバーが強制引き取りを実行でき、24h 未満では 403 になることを確認する（D-49）。
- 個人 mailbox 起点の proposal に対し、mailbox owner が cancel を実行でき、他ユーザーは 404/403 になることを確認する（D-49）。
- BU ユーザーの初回ログインで `email` claim ハッシュ照合により `google_subject_hash` が1回限り確定し、`pending_subject_bind` 中は通常 API が 403 になることを確認する（D-50）。
- Calendar worker の partial_failed / replan_required / 全失敗 / result_unknown の各結果に対し、proposal が定義済み終端状態に遷移し `execution_pending` に滞留しないことを確認する（D-48）。
- `all_approved` 遷移時に replyDraft が確定 slot 日時で再生成され、`pending_reply_approval` のカードに合意日時が含まれることを確認する（D-52）。
- Front / Terraform の正本と矛盾する記述がある場合、Back docs はアプリケーション実装責務に限定して修正される。
