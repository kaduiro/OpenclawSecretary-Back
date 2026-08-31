# Backend Design: Gmail AI Secretary

## 実装との関係（2026-07-16）

本書は完成時のbackend設計を含む。現在のコードで成立している経路は[現行実装ベースライン](../../implementation/current-implementation.md)を参照する。OAuth、認可、Gmail送信/reconcile、Calendar承認状態遷移、Outbox、retentionは実装済みだが、AI/RAGとCalendar planner/DwDは未実装である。Components表の該当項目は目標設計として読むこと。

また、現在のOAuth scopeは`openid email gmail.modify`のみで、Calendar scopeを含まない。Calendar providerを本番利用する前にscope追加と再同意が必要である。

作成日: 2026-06-25 | 更新日: 2026-07-15 (D-37〜D-46 反映: provisioning・resource認可・増分polling・副作用回復・AI境界・決定的scheduler) | ステータス: DRAFT

この文書は Back repository の実装設計正本である。分割前 `design.md` のうち、API、domain service、DB access、AI/RAG、Google API client、worker、監査出力に関する内容を保持する。

## Components

| Component | Responsibility |
|---|---|
| API server | OpenAPI に定義された HUD / internal endpoint を提供する |
| Auth module | Google ID token の署名・issuer・expiration・aud・hd と `users(provisioning_status=active)` を検証する。認証後は endpoint ごとに owner mailbox／同一BU／current claimant／proposal participant を検証し、境界外 resource は 404 に正規化する。Admin SA、Gateway SA、Scheduler SA、Tasks SA は audience と subject/email allowlist を分離し相互利用を拒否する（D-38） |
| OAuth module | numeric loopback、state/nonce/OAuth PKCE/return_uri/HUD handoff challengeをbindする。callbackはopaque codeと固定auth-bootstrap URLだけを渡し、HUD-held verifierを限定公開auth-bootstrapで検証してID tokenを返す。Bootstrap SAはprivate redeemだけを呼べる。ID token検証後は`oauth_provisioning` user→Secret保存→active。scopeはopenid/email + Gmail + Calendar events/freebusy（D-37/D-39/D-55） |
| Gmail service | mailbox ごとの `last_history_id` を使って Gmail History API を差分取得し、期限切れ時だけ限定 full sync へ戻る。`(mailbox_ref,gmail_id)` で重複排除し、mailbox単位lock・bounded concurrency・continue-on-errorで処理する。draft/send は `mail_send_operations` で外部結果を照合する（D-43/D-44） |
| AI analyzer | メール／予定本文を非信頼 data として system instruction から分離し、分類・返信要否・日程調整要否を version 付き JSON Schema と allowlist で検証する。失敗時は manual_action_required を保存する（D-41/D-45） |
| RAG engine | FAQ / sent reply embedding を検索する。検索結果を命令として扱わず、source/type/length allowlist と PII sanitizer を通した引用 data としてだけ返信生成へ渡す（D-45） |
| Calendar planner | DwD events と OAuth freeBusy（calendar.events.freebusy scope）を用途別に取得し、取得直後にattendee_refへ変換する。SchedulingPolicyのtimezone/duration/step/notice/holiday/all-day/transparent/recurrence/DSTと固定tie-breakを適用し、同一snapshotから同じslotId/rankを生成する。管理外必須参加者はmanual_review_requiredとし自動書込みしない（D-39/D-46） |
| Approval aggregator | 全員同一slot承認時、暗号化した不変 execution plan と outbox event を同一transactionで作成し、**確定 slot 日時で replyDraft を再生成・再暗号化して card_version++ する（D-52。AI 失敗時は確定日時テンプレート + 元 draft）**。Cloud Tasks enqueue は dispatcher が決定的task nameで行う。reject/selection conflict/superseded/cancelled/manual review の既存規則は維持する。cancel の実行権限は BU = current claimant / 個人 = mailbox owner（D-49） |
| Calendar worker | execution plan を復号・digest検証し、書込み直前に free/busy、slot freshness、proposal revision、event version/ETag、allowlist/actorを再検証する。不一致は書込みなしでreplan_required。外部結果不明時はoperation marker/event versionで照合してからretryを判断する（D-40/D-43）。結果確定後の proposal 終端遷移（D-48）: 全成功 → executed / 部分失敗 → executed_with_failures（手動補正カード）/ replan_required → superseded + 新 revision 自動生成 / business failure 全失敗 → manual_review_required / result_unknown → execution_pending 維持 + 運用 alert |
| Crypto module | Cloud KMS envelope encryption を集約する（D-51）。鍵リソース名は ENV で受領（Terraform 正本）、encrypt/decrypt は Cloud Run 実行 SA のみ、`*_key_version` による段階的再暗号化、復号は resource 認可済みパスのみで実行し結果を log / event_inbox に出さない |
| Outbox dispatcher | `outbox_events` をlease取得してCloud Tasksへ配送する。transient errorはbackoff再試行、already-existsは成功、上限超過はdead-letter/critical alertとする |
| DB client | Cloud SQL PostgreSQL への query、transaction、advisory lock を集約する |
| Audit logger | `timeline_events` と構造化 Cloud Logging への非 PII 出力を集約する |

## Interfaces

- 外部 contract は `docs/api/openapi.yaml` を唯一の OpenAPI 正本とする。
- Front に直接 DB / Secret Manager / Google OAuth token を触らせない。
- Terraform が作る resource 名、service account、secret 名は環境変数で受け取る。
- Back は Terraform state や gcloud 手順に依存せず、必要な runtime configuration の存在だけを検証する。

## Data Flow

1. Scheduler が `/internal/poll-gmail` を OIDC 付きで呼ぶ。Back は対象 mailbox を列挙し、mailbox lock と bounded concurrency の範囲で `last_history_id` から差分取得する。失敗は mailbox 単位で隔離する。
2. Back が各差分メールを `(mailbox_ref,gmail_id)` で冪等保存し、非信頼入力境界を通して AI analyzer/RAG engine で返信案を作る。AI失敗は null draft の手動対応、bounceは承認不要カードにする。
3. Back が承認待ち状態、`event_inbox` 通知本体、宛先ごとの `event_inbox_recipients` 行を Cloud SQL に保存する。`emails.mailbox_ref` に受信 mailbox の疑似識別子を記録する（D-22 / C-17）。
4. 各参加者の HUD が Gateway 経由で自分宛ての events と pending card を取得する。
5. Calendar planner は DwD events と OAuth freeBusy をマージし、SchedulingPolicyに従う決定的な最大3候補を作る。予定コンテキストは設定window内に限定し、通常proposalだけ参加者tokenを発行する。管理外必須参加者はmanual_review_requiredとして自動書込みを停止する。
6. 3候補を満たせない場合は、候補不足理由と代替案を保存して全参加者の HUD に返す。
7. 各参加者が自分の HUD で候補を1つ選んで承認、または拒否理由フォームから拒否 API を呼ぶ。Back は `proposal_approvals` のその参加者の行を更新し（approvalToken hash・cardVersion・subject hash・selectedSlotId を検証）、全行を集約確認する。
8. 通常 proposal で全員 approved かつ同一 selectedSlotId → aggregate_approval_status = all_approved → execution plan と outbox を commit。dispatcher が Cloud Tasks に配送する。1名でも rejected → any_rejected、selectedSlotId が割れた場合 → selection_conflict → 全員再投票。manual_review_required は operation/outbox を作らない。
9. 拒否または selection_conflict 後は、前回 proposal・拒否者の理由コード/マスク済み理由メモ/希望時間帯・他参加者の既存回答・最新 Calendar 空き状況から新しい revision を作成し、新 proposal_id に対して proposal_approvals 行を全参加者分新規 INSERT（status=pending / 新 approvalToken 発行）し、旧 proposal を superseded にする。旧行は監査履歴・拒否入力として不変のまま保持し（append-only）、replanner は parent_proposal_id チェーンを遡って拒否済み slot を再提示しない（D-20 / D-32）。候補0件の revision は proposal_approvals を作らず manual_review_required に直行し、revision >= 3 では replan せず manual_review_required / max_revisions_reached に遷移する（D-34）。
10. Gmail は mail_send_operations、Calendar は calendar_operations/operation_results により副作用前後の状態を永続化し、timeout 後は provider 側を照合してから再実行可否を決める。

## Error Policy

- 401 / 403 は即時エラーとし、自動 retry しない。
- 外部副作用は「無条件retry禁止」。副作用前と確定できるtransient failureはbackoff retryし、副作用後または不明な結果はprovider照合後にのみ再試行する。
- Calendar operation のterminal/partial failureは2xx + recorded result、pre-write transient failureは非2xxでCloud Tasks retry、stale planは2xx + replan_requiredとする。
- Calendar proposal の拒否は副作用を実行せず、代替案生成は新 revision 作成として扱う。
- 3候補を満たせない Calendar proposal は失敗ではなく、candidateLimitReason と代替案を持つ承認待ちカードとして扱う。
- 外部 API の raw response body を log に出さず、error code / exception class / correlation id に丸める。
- Gmail API 429 / quota 枯渇は該当アカウントを当該サイクルでスキップし、次の Scheduler 周期を実質リトライとする（D-36）。
- AI分析失敗は`analysis_status=failed`、allowlist済みerror code、暗号化draft=NULLとして保存し、approvalToken不要のmanual_action_required cardを返す（D-42/D-45）。
- Gmail draft 作成は emails 行の先行 INSERT（status='processing'）後に行い、orphan draft は `processing` + `draft_id IS NULL` 行の検出で回復する（D-36）。
- OAuth access token の並行 refresh は rotation 不使用のため無害。インスタンス内は attendee_ref 単位の in-memory キャッシュ + mutex で抑制する（D-36）。
- advisory lock は全て `pg_try_advisory_lock`（非ブロッキング）とし、取得失敗は 200 (skipped) を即返却する（D-36）。

## Security Boundaries

- 詳細は `docs/security/security_design.md` を正本とする。
- Back は token 検証、PII 匿名化、approvalToken hash、audit payload allowlist を実装する。
- Calendar 候補の設定済みcontext windowは認可済みdetail APIに限り、予定タイトル、マスク済み予定本文、参加者表示名を返せる。メールアドレス、Google event id、calendar id、会議URL、token は HUD/API/log/`timeline_events` に出さない。
- 事業部カレンダーのイベントタイトルに含まれる人名は取得後即座にattendee_refへ変換し、人名を保持しない（C-11）。activeなbusiness_units / membershipsが存在しない場合はCalendar処理全体をfail-closedでスキップする（C-12）。
- IAM、Cloud Run invoker、Secret Manager binding、Scheduler / Tasks OIDC 設定は Terraform 正本を参照する。
