# Backend Test Plan: Gmail AI Secretary

## 実施結果（2026-07-21）

2026-07-21の`npm run check`は成功し、Node test runnerの46 test、OpenAPI 47 path/49 operation、route登録49/49を確認した。対象には認証・resource認可、OAuth session、Gmail Push/watch、DLP後Gemini routingと日次上限、Gmail送信/reconcile、Calendar状態遷移、Outbox/dead-letter、retention、OpenAPI contractが含まれる。ただしOAuth providerのnonce claim欠落拒否は既存testの対象外である。

未実施のgateは、OAuth providerのnonce欠落拒否、raw claimant ID除去、Front main session競合、Terraform availability/latency、container署名producer、実PostgreSQL/pgvectorへのmigration、Docker image run、Google OAuth/Gmail/Calendar/Secret Manager/KMS/DLP/Vertex AI/PubSub/Cloud Tasksを接続したstaging E2E、AI draft承認接続、RAGおよびfreeBusy/DwDの試験である。単体テスト成功だけでprovider integration完了とは判定しない。詳細は[検証報告](validation_report.md)を参照する。

作成日: 2026-06-25 | 更新日: 2026-07-21 | ステータス: DRAFT

以下は実装済みtestだけでなく目標test matrixを含む。実施済みの証跡は上記実施結果と`validation_report.md`を正とする。

## Unit Tests

- Google ID token validation: issuer、signature、expiration、`aud`、`hd`、`sub`
- Gateway / Scheduler / Tasks / Admin OIDC validation: scheme別audience、service account email、endpoint allowlistとcross-call拒否
- approvalToken: plaintext 非保存、hash 照合、subject hash mismatch、cardVersion mismatch、再利用 409
- DwD allowlist: null / missing / empty / domain mismatch が fail-closed
- PII sanitizer: email、氏名、本文断片が AI payload / log payload から除外される
- OAuth session: numeric loopback、localhost/userinfo/query/fragment拒否、state/nonce/OAuth PKCE/return_uri/handoff challenge bind、callbackにID token非含有、verifier mismatch/expiry/replay拒否。nonce claim欠落・不一致のprovider testは未実装
- Resource policy: personal owner、同一BU member、current claimant、proposal participant、別BU、disabled userの表駆動判定
- AI schema gate: invalid JSON、unknown field、enum/length超過、prompt injection、RAG delimiter escape、sanitizer marker改変の拒否
- SchedulingPolicy: timezone fallback、DST gap/overlap、all-day busy、transparent ignore、recurrence expansion、固定tie-break

## Integration Tests

- OAuth exchangeがunknown subjectを`oauth_provisioning`で作成し、Secret保存後だけactive化する。Secret障害後のretryが重複user/secretを作らない
- `/internal/poll-gmail` がHistory checkpointから差分取得し、page transaction成功時だけcheckpointを進める。期限切れHistory IDは限定full syncで回復する
- 同じgmail_idを異なるmailboxで取り込め、同一(mailbox_ref,gmail_id)は重複しない。1 mailboxの429/障害中も他mailboxをbounded concurrencyで処理する
- BU 全員向け event_inbox で、1人の ACK が他メンバーの未ACKイベントを消さず、全 recipient 行 ACK 後のみ cleanup 対象になる
- `GET /v1/mail/{mailId}/detail` は個人ownerまたはBU current claimantだけdraft/tokenを返し、同一BU非claimantはclaimRequired metadata、別BUは404。subject responseはno-store
- 承認 / 拒否 API が DB 状態と `timeline_events` を更新する
- claim成功transactionで初回tokenを発行し、unclaim/timeout/transferで旧tokenを失効する。非claimant/revoked memberはapprove/reissueできない
- Gmail sendのdraft作成前/後、send前/response loss/DB保存前の各crash pointから再開し、二重送信せずsucceededまたはresult_unknownへ収束する
- Calendar operation/outbox作成のcommit前後、Tasks作成response loss、worker crashの各pointから再開し、operation/outbox欠落や二重writeを起こさない
- Calendar worker が成功、部分失敗、全失敗、pre-write transient retry、replan_required、result_unknownを記録する
- 実行直前にfree/busy、proposal revision、slot expiry、ETag/version、allowlistが変化した場合は書込みせずreplan_requiredになる
- 複数参加者の free/busy から全員参加可能な候補を最大3件生成する
- 3候補未満の場合、返せる候補、candidateLimitReason、期間外候補・期間拡張・参加者調整・手動確認の代替案を返す
- 対象期間内に共通空きがない場合、期間外候補は `isWithinRequestedPeriod=false` / `periodLabel=outside_requested_period` として返り、候補0件時は `slots=[]` と candidateLimitReason が返る
- 設定済みcontext windowに高優先予定がある候補のrankが下がり、同一snapshot/設定の再実行でslotId/rankがbyte-for-byte一致する
- Calendar approve は `selectedSlotId` を保存し、全員 approved かつ全員同一 selectedSlotId の場合のみ Calendar operation を enqueue する
- 全員 approved でも selectedSlotId が割れた場合は `selection_conflict` になり、Calendar operation が作成されない
- 1名でも拒否した場合は全員の回答を待たず `any_rejected` になり、拒否理由コード・マスク済み理由メモ・希望時間帯・他参加者の既存回答を使って新 revision が生成される
- 拒否済み Calendar proposal から alternatives API で新 revision が生成され、旧 proposal が superseded になる
- `pending_calendar` 中の BU 共有メールは claimed_at が2時間を超えてもクレーム自動解除されず、クレーム保持者が返信者として維持される
- 管理外必須参加者が含まれる場合、管理内参加者の空き状況だけで候補が生成され、proposal が `manual_review_required` で停止し、管理外参加者には approvalToken / event_inbox が発行されず、HUD にクレーム保持者向け手動確認テキストが表示される
- approved 行間に異なる selectedSlotId が2つ以上発生した時点で、残り参加者の回答を待たず `selection_conflict` に即時遷移する（D-35）
- superseded / cancelled proposal への approve / reject / reissue-token が `409 + code: proposal_superseded + supersededByProposalId` を返す（D-35）
- 代替案生成後も旧 proposal の `proposal_approvals` 行（選択 slot・拒否入力）が不変のまま残り、新 revision の候補に親チェーンの拒否済み slot が含まれない（D-32）
- クレーム保持者の cancel API で proposal が `cancelled`、`emails.status` が `pending_reply_approval` に戻り、2h クレームタイムアウトが再適用される。クレーム保持者以外の cancel は 403（D-34）
- 候補0件の revision では `proposal_approvals` が作成されず `manual_review_required` に直行する。`revision >= 3` では replan されず `max_revisions_reached` になる（D-34）
- `processing` + `draft_id IS NULL` の emails 行が次回ポーリングで検出され、orphan draft が再利用または再作成で回復する（D-36）
- Gmail 429は該当mailboxのcheckpointを進めずbackoffし他mailboxを継続する。AI失敗時は`analysis_status=failed`、replyDraft=null、manual_action_requiredカードになる
- MAILER-DAEMON / multipart-report メールが AI 分析対象から除外され、元メールに `mail_bounced` が記録される（D-36）
- titlePattern を変更しても attendee_ref・Secret Manager キー・proposal_approvals・クレームの紐付けが維持される（D-33）
- `/internal/retention/pii-mask` が 90 日超過 PII を mask / clear する。`proposal_approvals.rejection_reason_detail`（append-only 旧行含む）と解決後90日超の `emails.reply_draft_ciphertext` / `draft_id` が対象に含まれる（D-51）
- event_inboxは全recipient ACK後7日、FAQ候補30日、dispatched outbox30日で削除され、仮名化provider ID/暗号化plan/draftも定義期限とkey rotationに従う
- `pending_calendar` かつ `claimed_at > 24h` で同一 BU の別メンバーによる強制引き取り（自分宛 transfer）が成功し、24h 未満は 403、`timeline_events: mail_force_claimed` が記録される（D-49）
- 個人 mailbox 起点 proposal の cancel を owner が実行でき、非 owner は 404/403 になる。manual_review_required カードが BU=claimant / 個人=owner に表示される（D-49）
- BU ユーザーの初回ログインで `email` claim ハッシュ照合により subject が1回限りバインドされ、`pending_subject_bind` 中の通常 API・不一致 email・二重バインドが 403 になる（D-50）
- worker 結果 partial_failed / replan_required / business 全失敗 / result_unknown のそれぞれで proposal が executed_with_failures / superseded+新revision / manual_review_required / execution_pending維持+alert に遷移し、永久滞留しない（D-48）
- `all_approved` 遷移で replyDraft が確定 slot 日時付きで再生成・再暗号化され card_version++ される。AI 失敗時は確定日時テンプレートにフォールバックする（D-52）
- KMS 鍵 rotation 後、旧 key_version の行が読み取り時に段階的再暗号化され、非認可パスから復号 API が呼べない（D-51）
- settings PUT で既存 `businessUnitRef` の変更・削除が validation で拒否される（D-53）

## Contract Tests

- `docs/api/openapi.yaml` の schema と handler response が一致する
- Front consumption contract に記載された endpoint が OpenAPI から消えていない
- internal security scheme と HUD security scheme が混同されていない
- OpenAPI YAMLにduplicate key、未解決`$ref`、認証未指定のadmin endpoint、card variantのrequired矛盾がない

## Acceptance

- Gmail 送信と Calendar 書き込みは HUD 承認なしでは実行されない。
- DB / log / event inbox に OAuth token、approvalToken plaintext、メール本文 PII が保存されない。
- Calendar 候補の HUD/API には予定タイトル、マスク済み予定本文、参加者表示名を返せるが、メールアドレス、Google event id、calendar id、会議URL、token は返却・保存されない。
- Terraform の OIDC / IAM 設定を前提に、Back 側の token allowlist 検証が失敗時に閉じる。
