# Discovery Context: gmail-ai-secretary

Created: 2026-04-19 | Revised: 2026-07-21 (低コストPilot、Gmail Push、Gemini段階ルーティング) | Status: Updated | Policy: B (Contract)

---

## Goal

Gmailの大量処理、返信案作成、日程調整、FAQ蓄積を、デスクトップHUDでの明示承認を前提に省力化する。
OpenClawはGCP Cloud Runで実行し、HUDはCloud Run REST APIへ接続する。FAQ/RAGの正本はCloud SQL PostgreSQL + pgvectorとする。

---

## Key Decisions

| ID | Decision | Reason |
|----|----------|--------|
| D-01 | 実行基盤は Cloud Run | ローカル常駐プロセスやObsidian直接参照では、ゼロダウンタイム運用とクラウド認証境界を作りにくい |
| D-02 | HUDとOpenClawは HTTPS REST API で接続 | Electron rendererからCloud Run/Cloud SQLへ直接接続させず、main processでAPI clientを集約できる |
| D-03 | FAQ/RAGは Cloud SQL PostgreSQL + pgvector | Cloud Runから安定利用でき、FAQ本文、embedding、監査、送信済み返信履歴を同一DBで扱える |
| D-04 | Obsidian連携は必須範囲外 | Cloud RunはユーザーPCのvaultを直接読めないため。将来の任意export/import候補に留める |
| D-05 | Calendar write は冪等化必須 | retry、HUD二重クリック、Cloud Run revision重複で予定が重複作成されることを防ぐ |
| D-06 | Gmail pollingはCloud Scheduler、Calendar writeはCloud Tasksで起動 | Cloud Runをローカル常駐プロセスとして扱わず、HTTPリクエスト駆動の実行モデルに合わせる |
| D-07 | Gmail送信・Calendar書き込みは自動アプリ内リトライなし | 重複送信・重複イベント作成リスクが高く、失敗時は即座に「保留」へ遷移してユーザー判断に委ねる |
| D-08 | **SUPERSEDED by D-43**: Calendar書込みretryなし | 当時はmaxAttempts=1前提。現在はpre-write transientのみ冪等retry、terminal/recorded結果は2xx |
| D-09 | event_inboxは通知イベントのみ。カード本文正本はemailsテーブル（hud_display_ready=true） | event_inboxとemailsの責務を分離し、承認カード本文はGET /v1/mail/pendingで別途取得する |
| D-10 | error_logs独立テーブルなし（timeline_events + Cloud Logging） | エラー記録はtimeline_events（error_minor/error_critical種別）とCloud Logging（stdout）の2層で代替し、テーブル増殖を防ぐ |
| D-11 | Calendar監査独立テーブルなし（timeline_eventsに統合） | カレンダー操作の監査記録はtimeline_events（cal_succeeded/cal_partial_failed種別）に統合し、クロスユーザー更新の追跡を一元化する |
| D-12 | DwDは鍵レス署名（IAM Credentials API signJwt） | サービスアカウントキーJSONを発行・保存せず、Cloud Run実行サービスアカウントがIAM Credentials API signJwtでDwD用JWTに署名することで長期キーリスクを排除する |
| D-13 | Secret ManagerにsecretVersionAdderを付与（Gmail refresh token rotation用） | Gmail OAuth refresh tokenがGoogleのtoken rotationで更新された場合に、OpenClawが即座にSecret Managerの対象シークレットを新バージョンとして追加できるよう、secretAccessorとは別に対象secret限定のsecretVersionAdderを付与する |
| D-14 | DwD対象は個人アカウントではなく事業部共有アカウントに変更 | 事業部ごとに共有Googleアカウント（例: bu-ai@company.com）があり複数メンバーが同一アカウントを使用する組織構造のため、個人メールによる freeBusy 参照は使用しない。DwD impersonation 対象は事業部共有アカウントとし、そのアカウントの共有カレンダーから events を取得する |
| D-15 | Calendar候補生成は個人freeBusy APIではなく事業部カレンダーevents取得＋タイトル解析に変更 | 個人シフトはカレンダーイベントタイトルに『氏名 開始時刻-終了時刻』形式で記録されているため、Google Calendar Events API で取得後 titlePattern 照合でシフトを識別し、参加者ごとの busy/free を集計して候補日時を算出する |
| D-16 | メンバー定義を settings テーブルの businessUnits 構造で静的管理 | 誰がどの事業部に所属するかを管理する。旧sha256導出はD-33で廃止され、現在はtitlePatternからランダムattendee_refへのlookupを行う |
| D-17 | バックエンドは組織全体で1インスタンスを共有するマルチユーザーアーキテクチャ（案 A）を採用 | スケジュール変更の承認集約（複数参加者の承認状態を誰が集約するか）は共有 Cloud SQL で自然に解決できる。参加者ごとに別 GCP プロジェクトを作ると承認状態の共有手段が別途必要になりかえって複雑になる。全参加者が同一 Cloud Run + Cloud SQL を使用し、users テーブルと proposal_approvals テーブルでテナント分離する |
| D-18 | 個人 Workspace アカウントへの Calendar アクセスは DwD（事業部）+ OAuth（個人）の折衷方式（案 C）を採用 | 事業部共有カレンダーは管理者が一括設定した DwD で impersonation する（D-12 / D-14 継続）。個人 Workspace アカウントは各参加者が HUD 初回起動時に OAuth 同意フローを経て refresh token を Secret Manager（キー: `refresh-token/{attendee_ref}`）に保存する。DwD 権限を個人アカウントに広げず、管理者権限の過剰付与を防ぐ |
| D-19 | スケジュール変更の承認は対象参加者全員が各自の HUD で行う。全員承認で Calendar 書き込みを実行し、1名でも拒否で代替案フローへ遷移する | 秘書1名が代理承認する設計は誤りであった（訂正）。各参加者は自分の Google アカウントで認証した HUD から proposal_approvals への per-participant 承認操作を行う。全参加者の status が approved になった時点で calendar_proposals.aggregate_approval_status が all_approved に遷移し、Cloud Tasks へ operation を enqueue する |
| D-20 | 代替案提案時は全員が再投票する（案 A）。拒否者のみ再投票する案 B は棄却 | 再投票方針は維持するが、旧行UPDATEリセットはD-32で廃止。新revisionへ全員分を新規INSERTし旧行を保持する |
| D-21 | Gmail + Calendar スコープ統合（案 G-3A） | 個人 Workspace ユーザー（人事紹介事業部部長・役員 × 2）は Gmail と Calendar に同一 Google アカウントを使用する。単一 OAuth consent フロー（gmail.readonly + gmail.compose + calendar.events）で取得した refresh token を `refresh-token/{attendee_ref}` 1本で管理する。スコープ追加のため既存ユーザーには次回 HUD 起動時に再 consent が発生する |
| D-22 | per-mailbox 可視性分離（案 G-4A、D-54で所属正本更新） | BU共有mailboxはactiveなbusiness_unit_membershipsの全メンバー、個人mailboxはownerだけに表示する。mailbox_refとevent_inbox_recipientsでユーザー単位ACKを管理する |
| D-23 | マルチアカウントcontinue-on-error | 単一endpointで対象mailboxを列挙する方針は維持。逐次実行・固定lockはD-44が上書きし、現在はmailbox checkpoint/lock/bounded concurrencyを採用 |
| D-24 | Gmail アカウント設定方式（複合案 Z、D-54で保存先更新） | BU共有Gmailは管理者がbusiness_units.calendar_accountへ登録する。個人Gmail自己登録時にactive BU accountとの重複は409で拒否する |
| D-25 | BUユーザーはAdmin SAで事前登録 | 事前登録方針と自己選択禁止は維持。attendee_ref導出はD-33が上書きし、backendがランダムUUIDを生成する |
| D-26 | BU 共有メールの並行作業防止：先着クレーム方式 + advisory lock（namespace=4）の組み合わせ採用 | BU 共有メールを同一事業部の複数メンバーが同時に操作することを防ぐ。第1層（UI 排他）：`POST /v1/mail/{mailId}/claim` で `emails.claimer_attendee_ref` を atomic conditional UPDATE（WHERE claimer_attendee_ref IS NULL）。クレーム済みの場合は 409 を返す。第2層（処理排他）：承認操作（Gmail 送信・Calendar 書き込み）直前に `pg_try_advisory_lock(4, hashtext(mailId))` を取得し、二重実行を防ぐ。2h タイムアウトは `claimed_at < now() - interval '2 hours'` のレイジー評価で自動リセット（HUD クラッシュ安全弁）。ただし `emails.status = 'pending_calendar'` の間は Calendar 参加者全員の承認待ちが2時間を超え得るため、タイムアウト自動リセットの対象外とする |
| D-27 | クレーム解除・移譲 API の提供 | クレーム保持者が作業を手放す手段として2つの API を提供する。解除（`DELETE /v1/mail/{mailId}/claim`）: 自分のクレームを解除して未着手に戻す。他人のクレーム解除は 403。event_inbox: mail_unclaimed を BU 全員に配信する。移譲（`POST /v1/mail/{mailId}/transfer`）: body { targetAttendeeRef } で同一 BU メンバーへ移譲。approvalToken 再発行・approval_subject_hash 更新・card_version++ を1トランザクションで実行。event_inbox: mail_transferred を BU 全員に配信する。異なる BU メンバーへの移譲は 400 |
| D-28 | チケット制 UI は v2 でフロントエンドのみ追加（バックエンド変更なし） | Jira 型チケットリスト UI（未着手 / 自分が担当 / 待機中（pending_calendar）/ 他人対応中 の4セクション）を将来の v2 としてフロントエンドに追加する。バックエンドは `emails.status` + `emails.claimer_attendee_ref` の組み合わせをフロントエンドが読み替えることでチケット状態を導出するため、バックエンド変更は一切不要。`GET /v1/mail/tickets`（軽量メタのみ、bodyPreview / replyDraft なし）と `GET /v1/mail/{mailId}/detail`（重データ、要求時のみ）の2エンドポイントを v2 で追加する ※ **D-29 により v1 MVP に繰り上げ** |
| D-29 | MVPスコープ確定: D-28 の「v2」スコープを撤回しすべての機能を v1 に繰り上げ | D-28 でフロントエンド v2 として分類した `GET /v1/mail/tickets`・`GET /v1/mail/{mailId}/detail`・クレーム移譲（`POST /v1/mail/{mailId}/transfer`）を v1 MVP に繰り上げる。30人規模の組織では段階リリースより全機能一括提供を優先できる。**v1 MVP スコープ**: BU ユーザー登録（`POST /internal/admin/users`）・クレーム取得（`POST /claim`）・クレーム解除（`DELETE /claim`）・クレーム移譲（`POST /transfer`）・チケット一覧（`GET /tickets`）・メール詳細（`GET /detail`）・カレンダー候補生成/承認・メール分類/返信案生成・Gmail ポーリング |
| D-30 | DDL（migration SQL）を実装フェーズの正本とする | 設計フェーズでは `db_design_document.md` が正本。実装フェーズでは `migrations/*.sql`（migration DDL）が唯一の正本となる。`db_design_document.md` はその人間可読な設計説明文書として参照する。`er_diagram.md`・`db_columns_list_with_relations.md` は常時参考補助文書（乖離許容）とし、優先順位は **migration DDL > db_design_document.md > er_diagram/db_columns** とする |
| D-31 | slotId による候補選択集約と selection_conflict フロー（D-19 拡張） | Calendar 候補の各スロットに一意の `slotId`（例: `slot-1` / `slot-2` / `slot-3`）を付与する。各参加者は承認時に特定の slotId を選択して `proposal_approvals.selected_slot_id` に記録する。全員承認かつ全行の `selected_slot_id` が同一 → `aggregate_approval_status = all_approved`（Calendar operation 実行）。全員承認だが `selected_slot_id` が割れた → `selection_conflict`（代替案フロー、全参加者再投票）。拒否参加者は `rejected_slot_ids`（避けたいスロット最大3件）と `preferred_windows`（都合のよい時間帯最大3件）を入力でき、代替案生成時の再候補計算に使用する。`operation_id` の生成ハッシュには `selectedSlotId` を含める |
| D-32 | proposal_approvals は append-only（revision ごとに新規行を INSERT。「リセット」= UPDATE クリアは廃止） | BE-REQ-022 / D-20 の「全参加者分リセット」を UPDATE ではなく新 revision（新 proposal_id）への新規行 INSERT に変更する。理由: ① UPDATE クリアでは superseded proposal の「誰が何を選び・なぜ拒否したか」の監査履歴が消失する ② 2回目以降の replan で過去 revision の `rejected_slot_ids` / `preferred_windows` を累積参照できず、拒否済み時間帯を再提案するループの温床になる。replanner は `parent_proposal_id` チェーンを遡って全 revision の拒否履歴を累積入力とし、拒否済み slot を再提示しない |
| D-33 | attendee_refはsha256導出をやめランダム生成の不変UUIDに変更（D-54で属性保存先更新） | titlePattern/emailは可変属性、attendee_refは不変とする。titlePattern対応はbusiness_unit_membershipsでlookupする。mailbox_refのsha256導出は変更しない |
| D-34 | proposal 手動キャンセル API・候補0件終端・revision 上限 3 | ① `POST /v1/calendar/proposals/{proposalId}/cancel`（クレーム保持者のみ）で proposal → `cancelled`、全 proposal_approvals 無効化、`emails.status` を `pending_calendar` → `pending_reply_approval` に戻す。cancel 後は 2h クレームタイムアウトの適用対象に復帰するため、保持者不在の詰みも自動解消する。cancel 後の返信は gmailMessageId ナビゲーションで手動返信へ誘導（AI 返信案再生成は v2）。② replan が候補0件（slots=[]）の revision を作る場合は proposal_approvals を作成せず `status = manual_review_required` に直行し投票フェーズをスキップする。③ `revision >= 3` で replan せず `manual_review_required` / `candidateLimitReason = max_revisions_reached` に落とす（selection_conflict 無限ループ防止）。OQ-MULTI-005 はこれで CLOSE（MVP = 手動キャンセルのみ。自動 stale 検出は v2） |
| D-35 | superseded proposal へのレース応答と selection_conflict の即時判定 | ① 1名拒否→即時 replan 後、他参加者が旧カード（最大10秒のポーリング遅延）から approve/reject した場合は `409 + code: proposal_superseded + supersededByProposalId` を返し、HUD は新 proposal のカードへ自動遷移する。ほぼ同時の複数拒否では2人目の拒否入力は新カード上で再入力する（1周余計に回り得るが整合性が単純。デバウンス集約は v2）。② selection_conflict は「全員 approved 後」ではなく「approved 行間に異なる selectedSlotId が2つ以上存在した時点」で即時遷移する。全員一致が成立条件である以上、2名が異なる slot を選んだ瞬間に conflict は論理的に確定しており、残りの投票を待つ意味がない（1名拒否の即時性と対称化） |
| D-36 | A-1 / A-2 / B-1〜B-5 の解決方針確定 | **A-1**: advisory lock は全て `pg_try_advisory_lock`（非ブロッキング）に統一し取得失敗は 200 (skipped) 即返却（待機が存在しないためタイムアウト定義不要）。クラッシュ時はセッション断で自動解放（PostgreSQL 仕様）。保険として Cloud SQL の `idle_in_transaction_session_timeout` を設定。**A-2**: emails 行を `status='processing'` で先行 INSERT → Gmail draft 作成 → draft_id UPDATE の順に変更。クラッシュ時は `processing` + `draft_id IS NULL` 行を次回ポーリングで検出し、drafts.list で既存 draft を再利用または再作成。**B-1**: Gmail 429 は該当アカウントを当該サイクルでスキップ（次の5分周期が実質リトライ）。AI 失敗は fallback 値（category=その他 / urgency=中 / is_schedule=false / replyDraft=null）+ `analysis_failed=true` で保存し「AI 分析失敗・手動対応」カードを表示。**B-2**: In-Reply-To が自送信 message-id と一致 → 新規カードに「返信スレッド」ラベル付与のみ（文脈統合 AI 分析は v2）。**B-3**: `From: mailer-daemon@*/postmaster@*` または `Content-Type: multipart/report` → AI 分析スキップ、元メールの timeline に `mail_bounced` 記録、承認不要の通知カード表示。**B-4**: 承認時 Gmail draft 404 → `status='draft_missing'` + HUD にエラー表示、replyDraft から draft 再作成可能。**B-5**: refresh token rotation 不使用のため並行 refresh は無害（両 access token が有効）。インスタンス内は attendee_ref 単位の in-memory キャッシュ + mutex とだけ明文化 |
| D-37 | OAuth bootstrapとhandoff境界 | OAuth exchangeでuser/attendee_refをprovisioning作成しSecret保存後active化する。通常allowlistは緩和しない。numeric loopbackとstate/nonce/OAuth PKCE/URI/HUD handoff challengeをbindし、callbackはopaque codeだけ、verifier redeem後にID tokenを返す |
| D-38 | admin RBACとresource authorization | settings更新・BU user登録は専用Admin SA OIDC schemeを使用する。一般APIは認証後にmailbox membership、recipient、claimant、proposal participant、operation participantを必ず検証する。ID推測による越境は404で隠す |
| D-39 | Calendar scopeをAPI能力へ整合 | 個人OAuthへ`calendar.events.freebusy`を追加する。freeBusyはbusy区間、`calendar.events`によるevents.listは認可された予定詳細と書き込みに限定し、他参加者へ返す詳細はマスク済み表示契約に従う |
| D-40 | Calendar実行前再検証 | attendee別operation planにaction、暗号化target reference、expected ETag、desired payloadを保存する。workerはfreeBusy/ETagを直前再検証し、提案後に競合が生じた場合は書き込まずreplan_requiredへ遷移する |
| D-41 | BU共有mail tokenはclaim後に発行 | 未クレーム共有mailはtokenなしsummaryだけを配信する。claim transactionでcaller membershipを検証し、claimer・subject binding・token hash・cardVersionを更新する。detail/approve/reject/reissueはcurrent claimantだけに許可する |
| D-42 | AI失敗とdraft本文を明示的にモデル化 | emailsにanalysis status/errorと暗号化reply draftを保持する。API cardはapproval/manual-action/bounceのvariantへ分離し、AI失敗cardにreplyDraft/approvalTokenを要求しない。draft_missingは保存済み暗号化draftから回復する |
| D-43 | 外部副作用はoperation ledger + outboxで回復 | Gmail送信はprepared/draft_created/sending/succeeded/result_unknown/failed_terminalを記録し、不明結果をpendingへ戻さない。Calendar operationとoutboxを同一transactionで作成し、transport failureは冪等再試行、attendee別成功結果はskipする。D-08/C-10の一律maxAttempts=1は本決定で上書きする |
| D-44 | Gmail pollingはmailbox別増分checkpoint | Gmail History APIのhistoryId/page tokenをmailboxごとに管理し、期限切れ時だけfull syncする。重複keyは(mailbox_ref,gmail_id)、lockはmailbox単位、処理はbounded concurrencyとする |
| D-45 | AI非信頼入力・仮名化データ境界 | mail/calendar/RAG textを命令から分離し、version付きJSON Schemaとallowlistで出力検証する。attendee_ref、provider ID、embeddingは仮名化個人データとして扱う。event inboxは全recipient ACK後7日で削除する |
| D-46 | deterministic scheduling policy | timezone、duration、slot step、minimum notice、holiday/all-day/transparent/recurrence/DST、tie-breakを設定化し、slotId/rankの決定性を保証する |
| D-47 | timeline_events enum の正本復元と状態語彙対応表 | v2.1 更新時に縮小された event_type enum を復元し（`cal_replanned` / `cal_candidate_limited` / `cal_superseded` / `cal_cancelled` / `token_reissued` / `mail_bounced` / `error_minor` / `error_critical` / `faq_suggested` / `faq_registered` / `draft_saved` / `draft_deleted`）、D-37〜D-46 系の `user_provisioned` / `user_bound` / `user_disabled` / `mail_force_claimed` / `send_result_unknown` / `cal_replan_required` を追加する。timeline_events は D-10（error_logs 廃止の代替）の監査正本のため、enum 漏れ = 監査要件の実装不能となる。あわせてメール状態の3系統語彙（DB 日本語 enum / API 英語 enum / フロー図表記）の対応表を db_design_document.md に正本として定義し、`pending_approval` 等の enum 外表記を排除する |
| D-48 | Calendar 実行結果の proposal 終端遷移 | `executed` = 全書込み成功のみに厳格化（D-43）した結果、他の worker 結果の受け皿を定義する。① partial_failed → `executed_with_failures`（新 status。クレーム保持者/個人 owner に手動補正カードを表示）② replan_required（D-40 の直前再検証で競合検出）→ 自動で superseded + 新 revision 生成（Flow 5 に合流）③ business failure での全失敗 → `manual_review_required` ④ result_unknown → reconcile 完了まで `execution_pending` 維持 + 運用 alert。これにより execution_pending への永久滞留を排除する |
| D-49 | クレーム救済（force-claim）と cancel/手動カード権限の統一 | ① `pending_calendar` 中でも `claimed_at > 24時間` の場合に限り、同一 BU の active メンバーが強制引き取り（自分宛 transfer）を実行できる。D-41 のトークン再バインドを流用し、`timeline_events: mail_force_claimed` で監査する。これによりクレーム保持者不在（退職・長期不在）のデッドロックを解消する（D-26 の例外規定）。② cancel API（D-34）と manual_review_required 系手動対応カードの実行者/宛先を D-38 の resource authorizer と同一の判定「BU 共有 = current claimant / 個人 mailbox = `emails.owner_attendee_ref`」に統一する。個人メール起点 proposal の cancel 不能・カード宛先不定を解消する |
| D-50 | BU ユーザーの subject bind-on-first-login | 管理者は Google `sub` を事前に知り得ないため、BE-REQ-028 の「登録時に google_subject_hash 設定」を改める。管理者登録時は `users.pending_email_hash = sha256(email)` を仮バインド識別子として保存し `provisioning_status = 'pending_subject_bind'` とする。本人の初回ログインで ID token の `email` claim（`hd` 検証済み）のハッシュを照合し、一致時に `google_subject_hash` を1回限り確定・`pending_email_hash` をクリアして `active` へ遷移、`timeline_events: user_bound` を記録する。不一致は 403。D-37 の provisioning_status 状態機械に1状態追加するだけで実現する |
| D-51 | Cloud KMS 鍵管理と retention 補完 | reply_draft / execution plan / faq_candidates の envelope encryption（v2.1 導入）に対する鍵管理を定義する。KeyRing / CryptoKey / IAM binding は Terraform 正本とし、Back は鍵リソース名を ENV で受領する。encrypt/decrypt 権限は Cloud Run 実行 SA のみ。rotation は新 key version での暗号化開始 + `*_key_version` カラムによる段階的再暗号化。復号は resource 認可済みパス（detail API・送信処理・worker）のみで行い、復号結果を log / event_inbox に出さない。retention に `proposal_approvals.rejection_reason_detail`（90日でクリア。reason_code / rejected_slot_ids / preferred_windows は非PII として保持）と `emails.reply_draft_ciphertext` / `emails.draft_id`（メール解決から90日で削除 / keyed hash 化）を追加する |
| D-52 | all_approved 時の replyDraft 確定日時再生成 | Branch B の返信 draft は Calendar 承認前に生成されるため合意日時を含まない。`all_approved`（execution plan commit）遷移時に確定 slot 日時を差し込んで replyDraft を再生成・再暗号化し `card_version++` して `pending_reply_approval` へ遷移する。AI 再生成失敗時は「確定日時のテンプレート文 + 元 draft 本文」にフォールバックし、最終確認は HUD 承認が担保する。cancel 経路（D-34）は従来どおり手動返信ナビゲーションとする |
| D-53 | 運用・外部仕様の細部確定 | ① `businessUnitRef` は BU 初回保存時に backend が採番し、以降の settings PUT では既存 BU の ref 変更・削除を validation で拒否する（BU 廃止は `disabled` フラグ）。② `POST /v1/faqs` は任意の `faqCandidateId` を受け、対応する faq_candidates 行を consumed に遷移する。明示 dismiss API は提供せず 30日自動削除で代替する。③ OAuth スコープ名 `calendar.events.freebusy` は Google の正式 granular scope 名（`calendar.freebusy` の可能性）と実装前に突合し、requirements / security_design / Terraform の3箇所を統一する（実装前検証タスク）。④ 従業員メール・カレンダーの常時 AI 解析に関する社内利用通知（目的・保持期間・問い合わせ窓口）を security_design のガバナンス節に定義し、社内規程への追記を運用前提とする |
| D-54 | review remediation実装でBU/所属を正規化 | business_units / business_unit_memberships / user_rolesを認可正本とし、settingsのbusinessUnitsは読取専用projectionへ変更する。Admin user登録は所属と同一transaction、BU廃止はdisabled_at、設定はrevision + ETag/If-Matchとする。D-22/D-24/D-33/C-12/C-16のsettings JSON参照を本決定が上書きする |
| D-55 | pre-login handoff redeem境界 | system browserのIAP cookieを共有しないElectron mainはIAP保護redeemをprogrammaticに呼べないため、redeemだけを提供する限定公開auth-bootstrap serviceを例外として追加する。60秒単回code + HUD verifierをauthorization proofとし、専用Bootstrap SAはprivate internal redeem以外で拒否する。ID tokenはbrowser/rendererへ渡さない |
| D-56 | 2ユーザー・1日30メールの低コストPilot | Gmail Pushを主経路、1時間pollingを通知欠落時の回復経路へ変更し、watchを日次更新する。PilotはCloud Run scale-to-zero、Cloud SQL `db-g1-small`/ZONAL、月額7,000円のBilling budgetを使用する。AIはDLP匿名化後のGemini 2.5 Flash-Liteを既定とし、返信・日程調整または低信頼時だけFlashへ昇格する。組織単位の日次request上限をDBで強制し、失敗時はmanual actionへ落とす。productionのREGIONAL HAとminimum instance guardは維持する |

---

## Constraints

| ID | Constraint |
|----|------------|
| C-01 | Gmail送信とCalendar書き込みはHUD承認後のみ実行する |
| C-02 | HUD rendererはCloud SQL、Secret Manager、Google OAuth tokenへ直接アクセスしない |
| C-03 | Cloud Runはステートレスとして扱い、永続データはCloud SQLへ保存する |
| C-04 | FAQ登録時はPII除去確認を行い、FAQナレッジDBへ保存する |
| C-05 | 重大障害はheartbeat異常から90秒以内にHUD表示する |
| C-06 | RAG検索 + AI回答案生成は p95 <= 32秒を試験基準にする |
| C-07 | HUD 本番 endpoint は IAP 保護 `openclaw-hud-gateway` とし、`openclaw-api` は `--no-allow-unauthenticated` + `--ingress=all` + gateway SA / Scheduler SA / Tasks SA の Cloud Run IAM `roles/run.invoker` + OpenClawアプリケーション側 Google ID/OIDC token 検証で保護する。HUD 利用者や Workspace domain には `openclaw-api` direct invoker を付与しない。マルチユーザー対応により `ALLOWED_SUBJECT`（単一値）を廃止し、**`users` テーブルの `google_subject_hash` に存在するかを DB で照合する** fail-closed 方式に変更する（D-17） |
| C-08 | Gmailエラー率SLO: Gmail送信失敗率（承認操作のうち「保留」へ遷移した割合）は <= 1%（7日間ローリングウィンドウ・営業時間内） |
| C-09 | Calendarエラー率SLO: Calendar承認操作のうちcal_partial_failedとなった割合は <= 5%（7日間ローリングウィンドウ） |
| C-10 | **SUPERSEDED by D-43**。一律maxAttempts=1は廃止し、pre-write transientだけ冪等retry、terminal/recorded結果は2xxとする |
| C-11 | 人名PIIを取得後即時にattendee_refへ変換する境界は維持。sha256導出はD-33で廃止し、settings lookupでランダムUUIDへ変換する |
| C-12 | activeなbusiness_units / membershipsが存在しない場合はfail-closedとし、Calendar events取得・書き込みを行わない |
| C-13 | スケジュール変更の approvalToken は参加者ごとに個別発行する。`proposal_approvals` テーブルで（proposal_id, attendee_ref）の UNIQUE 制約のもと per-participant に管理し、`calendar_proposals` テーブルの単一 `approval_token` カラムは廃止する |
| C-14 | 個人 Workspace アカウントの OAuth refresh token は Secret Manager キー `refresh-token/{attendee_ref}` で参加者ごとに管理する。HUD 初回起動時に OAuth 同意フローを経て保存する。事業部共有アカウントは DwD のまま変更しない（D-18） |
| C-15 | マルチユーザーバックエンドにおいて `users` テーブルが認証の唯一の allowlist となる。`google_subject_hash` が `users` テーブルに存在しない場合は 403 とし、ENV の `ALLOWED_SUBJECT` 環境変数は廃止する（D-17） |
| C-16 | activeなbusiness_units.calendar_accountは個人アカウントとして自己登録できず、重複時は409を返す |
| C-17 | `emails.mailbox_ref` は sha256(gmailAccount + perUserSalt) で生成する。メールを受信した Gmail アカウントを特定し、D-22 の per-mailbox 可視性制御に使用する。生 Gmail アドレスは DB・ログ・event_inbox に保存しない |
| C-18 | BU ユーザーの `users.attendee_ref` は管理者が `POST /internal/admin/users`（IAP + Admin SA 限定）を通じて事前に登録することで確定する。ユーザー自身による attendee_ref の自己選択・HUD 上での氏名選択・自動マッチングは、Calendar データへの不正アクセス・なりすましリスクがあるため禁止する（D-25） |

---

## Assumptions

| ID | Assumption |
|----|------------|
| A-01 | ユーザーはGoogle WorkspaceまたはGmail/Calendar APIを利用可能なGoogleアカウントを持つ |
| A-02 | **SUPERSEDED by D-56**。Gmail Push Notificationsを主経路として実装し、Cloud Scheduler pollingは1時間周期の回復経路として残す。 |
| A-03 | 複数参加者Calendar参照・更新には Google Workspace 管理者による Domain-wide Delegation 設定が必要。DwD 対象は個人アカウントではなく事業部共有アカウント（例: bu-ai@company.com）とし、個人シフトは共有カレンダーのイベントタイトル解析で識別する（D-14 / D-15）。Domain-wide Delegation が利用不可の場合、参加者カレンダー参照・更新はスキップし、REQ-CAL-001 の例外処理に従う |
| A-04 | Electron HUDはWindows 11を優先対象とする |
| A-05 | FAQ入力はHUDのFAQ管理/登録UIを正とする |

---

## Blast Radius

| Target | Operation | Risk / Guardrail |
|--------|-----------|------------------|
| Gmail | Read | メール本文とメタデータを読む。Cloud SQL保存時はアクセス制御と保持期間を適用する |
| Gmail | Draft/Send | HUD承認後のみ送信する。承認操作IDで二重送信を防ぐ |
| Google Calendar | Read | 本人および許可済み参加者の空き時間を参照する |
| Google Calendar | Write | HUD承認後のみ作成/更新する。固定eventIdとoperation lockで冪等化する |
| Cloud SQL PostgreSQL | Read/Write | メール、タイムライン、FAQ、embedding、承認状態を保存する。HUDからの直接接続は禁止 |
| Secret Manager | Read / Version Add | Cloud Run が秘密情報を取得し、Gmail refresh token rotation 時のみ対象 secret に新 version を追加する |
| Electron HUD | Render/Action | 承認カード、FAQ管理、障害表示を行う。秘密情報は保持しない |

---

## Open Questions

| OQ-ID | Question | Status |
|-------|----------|--------|
| OQ-FAQ-001 | FAQナレッジの入力手段 | CLOSED: HUDのFAQ管理/登録UIを正とする |
| OQ-CR-001 | HUDとCloud Runの接続方式 | CLOSED: Electron main process の HTTPS REST client |
| OQ-CR-002 | ローカルObsidian vaultをCloud Runから参照するか | CLOSED: 参照しない。Cloud SQL + pgvectorに一本化 |
| OQ-CR-003 | データ永続化はSQLite継続かCloud SQL移行か | CLOSED: Cloud SQL PostgreSQL + pgvectorへ移行 |
| OQ-CAL-001 | 両者出席必須のスケジュール変更で受信者単独承認時、内部ユーザー識別方法は何か | CLOSED: 組織ドメインメールアドレスで識別。具体的なドメインはREQ-CONFIG-001の設定ファイルで管理する |
| OQ-CAL-002 | REQ-CAL-006の複数参加者更新保証はどこまでか | CLOSED: best-effort all-or-recorded-failure。分散トランザクション・自動ロールバックは使用しない。途中失敗時は attendee_ref 単位の非PII結果をcalendar_operation_resultsに保存し、timeline_eventsには operationId/status/correlationId/非PII skip reason/errorCode/exceptionClass の allowlist のみ記録して手動補正要を通知する |
| OQ-PF-001 | 「返答不要」と判定されたメールの最終ステータス | CLOSED: 自動で「解決済み」に遷移し、HUD承認カードは生成しない |
| OQ-PF-002 | HUDに複数の承認カードが同時に存在する場合の表示順序・スタック管理 | CLOSED: 緊急度降順、同一緊急度内は受信日時昇順（FIFO）で表示する |
| OQ-NOTIFY-001 | OpenClaw→HUD通知方式 | CLOSED: HUD polling / event inbox方式を採用。OpenClawは通知イベント・FAQ候補・Calendar候補・エラー・operation状態変更をCloud SQL event inboxに保存し、HUDがGET /v1/eventsで10秒間隔polling。承認カード本文正本はemailsテーブル（hud_display_ready=true）でGET /v1/mail/pendingで取得。Cloud RunからHUDへの直接pushは採用しない |
| OQ-SLI-001 | HUD pollingによるSLI-01影響 | CLOSED: polling間隔を10秒に短縮し、HTTPS応答1秒と合わせて旧バッファ8秒枠を消費。SLI-01 p95 <= 140秒は維持するが追加バッファは0秒として管理する |
| OQ-API-001 | API surfaceの正本 | CLOSED: docs/specs/gmail-ai-secretary/openapi.yaml を正本とする |
| OQ-INFRA-001 | D-08の当時のinfra前提 | CLOSED、かつD-43でSUPERSEDED。現在はoutbox + 冪等worker + transient retryを正とする |
| OQ-AUTH-001 | IDトークン取得/更新方式 | CLOSED: RC-AUTH-001を2026-06-09設計で更新し、Electron main の TokenManager は Gateway/backend handoff で取得した短命ユーザーID tokenを Bearer として使用する。ID token の `aud` は OAuth client ID であり、Cloud Run URL audience は Scheduler/Tasks OIDC 専用とする。期限前更新は `/v1/auth/id-token/refresh` で一元管理し、IAM Credentials API generateIdToken は使用しない |
| OQ-EVENT-001 | event inboxの既読管理 | CLOSED: GET /v1/eventsのcursorは取得位置、POST /v1/events/{eventId}/ackは表示/処理済み状態として分離。未ACKイベントはHUD再起動時に再取得対象とする |
| OQ-OFFLINE-001 | HUDオフライン中の承認操作 | CLOSED: 疎通不明/オフライン時はGmail送信・下書き削除・Calendar更新など外部副作用を伴うボタンをdisabledとし、ローカルqueueには積まない |
| OQ-ID-001 | HUDに渡せる識別子境界 | CLOSED: Gmail draftIdはHUDに渡さず、mailId + 短命approvalToken + cardVersionで承認操作を行う |
| OQ-RUN-001 | Cloud Run上の定期/非同期処理モデル | CLOSED: Gmail pollingはCloud Schedulerから/internal/poll-gmailを呼び出し、Calendar複数参加者更新はCloud Tasksから/internal/calendar/operations/{operationId}/executeを呼び出す。Cloud Run内setIntervalやHTTP応答後の長時間処理は採用しない |
| OQ-NET-001 | Cloud Run endpointのprivate表現 | CLOSED: HUD は IAP 保護 `openclaw-hud-gateway` のみを呼び、`openclaw-api` direct invoker は gateway SA / Scheduler SA / Tasks SA に限定する。internal-only ingress/private endpointは通常のユーザーPC上HUDから直接到達できないため採用しない |
| OQ-UC-001 | FAQ編集/無効化のAPIをMVPに含めるか | CLOSED: OQ-RC-007 CLOSED により、MVPはFAQ候補登録・手動追加（POST /v1/faqs）のみ。編集/無効化/カテゴリタグ変更は将来拡張候補 |
| OQ-RC-001 | レビューサイクル1の確認必須事項 | CLOSED: Iteration 7で全CONFIRM_REQUIREDを解消。MVPは1ユーザー1GCPプロジェクト + 1Cloud SQL、PII非保持/疑似識別子化、Calendar PII HUD/API非表示、DwD allowlist fail-closed、approvalToken SHA-256ハッシュ保存・event_inbox平文非保持を正とする |
| OQ-TOKEN-001 | approvalToken の有効期間（token_expires_at の具体値）は何秒/時間/日か | CLOSED: 生成時から **72時間（259200秒）**。週末跨ぎ（金曜受信→月曜承認）に対応し、slot 陳腐化リスクを Calendar 側 reissue-token で検出する設計で均衡する |
| OQ-TOKEN-002 | approvalToken 期限切れ時の HUD 挙動・エラーコード・再発行フローをどう定義するか | CLOSED: HUD がカード取得時に `token_expires_at < now` を確認し、期限切れなら自動で `POST /v1/mail/{mailId}/reissue-token` または `POST /v1/calendar/proposals/{proposalId}/reissue-token` を呼び出し新トークンを透過的に取得する。Back は新 `crypto.randomBytes(32)` を発行して `token_expires_at = now + 72h`・`card_version++` を DB 更新し、`timeline_events` に `token_reissued` を記録する。Calendar 版は slot の開始時刻が過去になっていた場合のみ 200 + `slotExpired: true` で re-plan を促す。slot が全て有効な場合は透過的に新トークンを返す。再発行回数制限なし。approvalToken 平文は log / event_inbox に出さない（C-11 / C-12 境界を維持する） |
| OQ-RECONNECT-001 | HUD がオフラインからオンライン復帰した際、ポーリングのタイミングはどうするか | CLOSED: ハートビート（REQ-NET-004: 60秒間隔）が成功に戻った瞬間、次の10秒ポーリング周期を待たずに `GET /v1/events` を**即時1回実行**する。以降は通常の10秒間隔ポーリングに戻る。これにより復帰直後の最大遅延が10秒から約0秒に短縮される。未 ACK イベントはポーリング再開時に再取得される（OQ-EVENT-001 継続適用） |
| OQ-MULTI-001 | マルチユーザーバックエンドでの認証 allowlist をどう管理するか | CLOSED: `users` テーブルの `google_subject_hash` カラムを allowlist とする。Google ID token の `sub` を SHA-256 化して DB 照合し、存在しなければ 403。`ALLOWED_SUBJECT` 環境変数は廃止。ユーザー登録は管理 CLI または初回 OAuth 同意フロー完了時に自動登録（C-15） |
| OQ-MULTI-002 | proposal_approvals テーブルの per-participant approvalToken はどう発行・管理するか | CLOSED: proposal 生成時に参加者ごとに `crypto.randomBytes(32)` でトークンを生成し SHA-256 ハッシュを `proposal_approvals` に保存する。平文は GET /v1/calendar/proposals/{id} のレスポンスで各参加者の認証済みリクエストにのみ返す。card_version / token_expires_at / rejection_reason_code もすべて `proposal_approvals` で per-participant 管理し、`calendar_proposals` の単一 approval_token カラムは廃止する（C-13） |
| OQ-MULTI-003 | 個人 Workspace OAuth refresh token のper-user管理 | CLOSED: `refresh-token/{attendee_ref}`。attendee_refはD-33によりランダムUUID、保存順序はD-37のprovisioningフローを正とする |
| OQ-MULTI-004 | 全員が承認したことをいつ・どのプロセスが確認するか | CLOSED: `POST /v1/calendar/proposals/{id}/approve` のレスポンス処理内で `proposal_approvals` の全行を確認し、全員 approved になった時点で `calendar_proposals.aggregate_approval_status = all_approved` に更新して Cloud Tasks へ operation を enqueue する。ポーリング待ちや cron による集約チェックは不使用 |
| OQ-MULTI-005 | 未回答タイムアウト（72h 以内に全員が回答しない場合）の挙動をどうするか | CLOSED: D-34 で解決。MVP は `POST /v1/calendar/proposals/{proposalId}/cancel`（クレーム保持者のみ）による手動キャンセルのみを提供する。cancel で `emails.status` が `pending_reply_approval` に戻ると 2h クレームタイムアウトが復活するため、保持者不在の詰みも自動解消する。自動 stale 検出（例: 6日無回答で HUD にキャンセル提案表示）は v2 |
| OQ-GMAIL-001 | `business_units.calendar_account` はGmailとCalendarの両方に使用する共有アカウントを指すか | CLOSED: D-21/D-54。BU共有GmailとCalendarは同一アカウントで、DwD impersonation対象とする |
| OQ-GMAIL-002 | Gmail と Calendar は独立したワークフローか | CLOSED: D-21/D-22 確定（G-2 訂正）。スケジュール変更ありメールは Branch B（pending_calendar → Calendar 全員承認 → pending_reply_approval → mail_reply_ready → Flow 2）の統合フローを採る。Calendar 承認完了前に返信は送信されない |
| OQ-GMAIL-003 | 複数 Gmail アカウントをポーリングする場合のアーキテクチャをどうするか | CLOSED: D-23 確定（G-5A 採用）。単一エンドポイントで逐次ポーリング、continue-on-error |
| OQ-GMAIL-004 | 個人ユーザーの Gmail と Calendar を別トークンで管理するか | CLOSED: D-21 確定（G-3A 採用）。同一 refresh token で gmail.readonly + gmail.compose + calendar.events をカバーする |
| OQ-GMAIL-005 | メール可視性制御をどう実装するか | CLOSED: D-22 確定（G-4A 採用）。`emails.mailbox_ref` + `event_inbox.target_user_refs` で per-mailbox 分離 |
| OQ-GMAIL-006 | 個人 Gmail アカウントの登録はどのフローで行うか | CLOSED: D-24 確定（複合案 Z 採用）。本人が HUD 初回起動時に自己登録。BU 共有アカウントとの重複は 409 で拒否（C-16） |
| OQ-GMAIL-007 | BUユーザーのattendee_ref確定 | CLOSED: Admin SA事前登録時にbackendがランダムUUIDを生成（D-25をD-33で更新）。自己選択／自動マッチングは禁止 |
| OQ-GOOGLE-GROUPS-001 | Google Groups API による BU ユーザー自動同期の技術的可能性を評価すべきか | CLOSED: **不採用**。現在の組織規模（約30名）では `POST /internal/admin/users` による手動登録で運用コストは許容範囲内。Google Groups API 連携の実装コスト・C-18（なりすまし防止）の制約・`attendee_ref` と `titlePattern` の紐付けが自動化困難な点を考慮すると ROI が低い。組織が大幅に拡大した場合に再評価する（D-25/C-18 継続適用） |

---

## Current Implementation Targets

| Layer | Main Artifact |
|-------|---------------|
| HUD API client | `src/openclaw-client.js` |
| HUD IPC bridge | `src/mail-ipc.js` |
| Cloud Run API | `src/api-server.js` |
| Gmail polling | `src/gmail-poller.js` |
| RAG | `src/rag-engine.js` |
| DB access | `src/db-client.js` |
| Calendar write (Cloud Tasks worker) | `src/calendar-worker.js` |
| Calendar proposal (候補生成) | `src/calendar-planner.js` |
| DB migration | `migrations/` |
