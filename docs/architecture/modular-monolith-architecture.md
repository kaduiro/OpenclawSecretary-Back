# OpenClaw モジュラーモノリス アーキテクチャ

## 実装同期状況（2026-07-16）

本書は完成時の構成を含むアーキテクチャ設計である。現在の実装範囲は[現行実装ベースライン](../implementation/current-implementation.md)を参照する。現時点ではExpressモジュラーモノリス、46 API operation、PostgreSQL repository、Google OAuth/Gmail/Calendar adapter、Outbox/retention workerまで実装済みである。一方、AI/RAG、freeBusyを使うCalendar planner、Domain-wide Delegation、Cloud Tasksの実接続は完成時構成であり、実装済みとして扱わない。

図中のGCP構成はデプロイ目標を示す。ローカル自動検証は通過しているが、Cloud SQL migration、Google provider、Cloud Tasks、Secret Manager、KMSを接続したstaging E2Eは未完了である。

作成日: 2026-07-02 | 更新日: 2026-07-15 (D-37〜D-46: 組織共有境界・mailbox差分処理・operation ledger/outbox・実行時再検証) | ステータス: DRAFT

## Advisory Lock Namespace 対応表

| namespace | 用途 | 関数呼び出し例 |
|---|---|---|
| 1 | Gmail polling mailbox 排他 | `pg_try_advisory_lock(1, hashtext(mailboxRef))` |
| 2 | Calendar operation 冪等性保証 | `pg_try_advisory_lock(2, hashtext(operationId))` |
| 3 | PII retention 日次バッチ | `pg_try_advisory_lock(3, 0)` |
| 4 | BU 共有メール承認操作（クレーム）| `pg_try_advisory_lock(4, hashtext(mailId))` |
| 5+ | 将来追加モジュール | `pg_try_advisory_lock(N, hashtext(...))` |

> 正本: `history/discovery-context.md` の D-26・db_design_document.md の advisory-lock 設計節

---

## 1. GCP インフラ層 — 全体構造

```mermaid
flowchart TB
    subgraph EXTERNAL["外部"]
        HUD_USER["ユーザー\n(Windows HUD)"]
        GMAIL_API["Gmail API\n(Google)"]
        CAL_API["Google Calendar API\n(DwD)"]
        GEMINI["Gemini API\n(AI)"]
    end

    subgraph GCP["GCP プロジェクト（1組織 = 1専用デプロイ）"]
        subgraph TRIGGERS["トリガー層"]
            SCH_GMAIL["Cloud Scheduler\npoll-gmail (5分毎)"]
            SCH_PII["Cloud Scheduler\npii-mask (毎日)"]
            TASKS["Cloud Tasks\ncalendar-operation-queue\ntransient retry + backoff"]
        end

        subgraph GATEWAY_LAYER["ゲートウェイ層"]
            IAP["Cloud IAP\n(HUD ユーザー認証)"]
            HUD_GW["openclaw-hud-gateway\nCloud Run (IAP protected)"]
        end

        subgraph APP_LAYER["アプリケーション層"]
            OC_API["openclaw-api\nCloud Run\n(no-allow-unauthenticated)\n(--ingress=all)"]
        end

        subgraph DATA_LAYER["データ層"]
            SQL["Cloud SQL\nPostgreSQL + pgvector"]
            SM["Secret Manager\n(refresh token / API key / client secret)"]
            LOG["Cloud Logging\n(構造化 JSON)"]
        end

        HUD_USER --> IAP --> HUD_GW
        HUD_GW -->|"Bearer ID token\ngateway SA invoker"| OC_API
        SCH_GMAIL -->|"OIDC token\nscheduler SA invoker"| OC_API
        SCH_PII -->|"OIDC token\nscheduler SA invoker"| OC_API
        TASKS -->|"OIDC token\ntasks SA invoker"| OC_API

        OC_API --> SQL
        OC_API --> SM
        OC_API --> LOG
    end

    OC_API --> GMAIL_API
    OC_API --> CAL_API
    OC_API --> GEMINI
```

---

## 2. openclaw-api 内部構造（モジュラーモノリス）

```mermaid
flowchart TB
    subgraph OC_API["openclaw-api (Cloud Run プロセス)"]
        SERVER["api-server.js\n＝ Express アプリ + モジュールルーター"]

        subgraph CORE["src/core/ ── 全モジュール共有基盤"]
            AUTH["auth-middleware.js\nID token / OIDC token 検証\nHUD用とScheduler/Tasks用を分離"]
            DB["db-client.js\n接続プール管理\nadvisory lock API"]
            AI["ai-adapter.js\nGemini API 抽象化\nモデル切り替え口"]
            PII["pii-anonymizer.js\nAI送信前 PII 置換\n[REDACTED_EMAIL] / [PERSON_N]"]
            AUDIT["audit-logger.js\ntimeline_events 追記\nCloud Logging 構造化出力"]
            SECRET["secret-client.js\nSecret Manager 参照\nrefresh token rotation"]
        end

        subgraph MOD_GMAIL["src/modules/gmail/ ── Gmail ワークフロー"]
            GM_ROUTES["routes.js\n/internal/poll-gmail\n/v1/mail/*"]
            GM_POLLER["gmail-poller.js\nGmail History API\nmailbox checkpoint・bounded concurrency"]
            GM_AI["ai-analyzer.js\nカテゴリ/緊急度/返信要否/日程調整要否判定"]
            GM_RAG["rag-engine.js\nFAQ + sent reply embedding 検索\n返信案 context 生成"]
            GM_APPROVAL["approval-handler.js\napprovalToken + resource認可\nmail_send_operations 照合"]
            GM_LOCK["advisory lock\nnamespace 1: mailbox polling\n(pg_try_advisory_lock(1, hashtext(mailboxRef)))"]
            GM_MIG["migrations/gmail/\n001_emails.sql\n002_faq_entries.sql ..."]
        end

        subgraph MOD_CAL["src/modules/calendar/ ── Calendar ワークフロー"]
            CAL_ROUTES["routes.js\n/internal/calendar/operations/:id/execute\n/v1/calendar/*"]
            CAL_PLANNER["calendar-planner.js\nfree/busy 取得\n候補生成・スコアリング"]
            CAL_WORKER["calendar-worker.js\nexecution plan再検証\n冪等書込み・結果照合"]
            CAL_APPROVAL["approval-handler.js\napprovalToken/resource認可\noperation + outbox 同時作成"]
            CAL_OUTBOX["outbox-dispatcher.js\nlease + 決定的task name\nretry/dead-letter"]
            CAL_LOCK["advisory lock\nnamespace 2: Calendar operation\n(pg_try_advisory_lock(2, hashtext(operationId)))"]
            CAL_MIG["migrations/calendar/\n001_calendar_proposals.sql\n002_calendar_operations.sql ..."]
        end

        subgraph MOD_RETENTION["src/modules/retention/ ── PII 保持管理"]
            RET_ROUTES["routes.js\n/internal/retention/pii-mask"]
            RET_JOB["pii-retention.js\n90日超過 PII マスク処理\n対象件数・失敗件数のみ出力"]
            RET_LOCK["advisory lock\nnamespace 3: PII retention\n(pg_try_advisory_lock(3, 0))"]
            RET_MIG["migrations/retention/\n（既存テーブル操作・スキーマ変更なし）"]
        end

        subgraph MOD_NEW["src/modules/{new-feature}/ ── 将来追加モジュール"]
            NEW_ROUTES["routes.js\n/internal/new-feature/*\n/v1/new-feature/*"]
            NEW_LOGIC["new-feature.js"]
            NEW_LOCK["advisory lock\nnamespace 5+: 将来モジュール\n(pg_try_advisory_lock(N, hashtext(...)))"]
            NEW_MIG["migrations/{new-feature}/"]
        end

        SERVER --> MOD_GMAIL
        SERVER --> MOD_CAL
        SERVER --> MOD_RETENTION
        SERVER --> MOD_NEW

        MOD_GMAIL --> CORE
        MOD_CAL --> CORE
        MOD_RETENTION --> CORE
        MOD_NEW --> CORE
    end

    style CORE fill:#d1ecf1,stroke:#17a2b8
    style MOD_NEW fill:#fff3cd,stroke:#ffc107
```

---

## 3. リクエストルーティングと認証分岐

```mermaid
flowchart TD
    REQ["HTTP リクエスト着信"]
    REQ --> PATH_CHECK{"パス判定"}

    PATH_CHECK -->|"/internal/*"| INTERNAL_AUTH["Internal スキーム検証\n（auth-middleware.js）\nOIDC token + SA email allowlist"]
    PATH_CHECK -->|"/v1/*"| HUD_AUTH["HUD スキーム検証\n（auth-middleware.js）\nGoogle ID token\naud / hd / sub 検証"]
    PATH_CHECK -->|"/oauth/*"| OAUTH_HANDLER["OAuth callback / ID token refresh\n（HUD スキーム適用後に処理）"]

    INTERNAL_AUTH -->|"失敗: 401/403 即時"| ERR_401["401/403\n詳細情報なし"]
    HUD_AUTH -->|"失敗: 401/403 即時"| ERR_401

    INTERNAL_AUTH -->|"成功"| MODULE_ROUTER["モジュールルーター\n（api-server.js）"]
    HUD_AUTH -->|"成功"| MODULE_ROUTER
    OAUTH_HANDLER --> MODULE_ROUTER

    MODULE_ROUTER -->|"/internal/poll-gmail\n/v1/mail/*"| GM_MODULE["Gmail モジュール"]
    MODULE_ROUTER -->|"/internal/calendar/*\n/v1/calendar/*"| CAL_MODULE["Calendar モジュール"]
    MODULE_ROUTER -->|"/internal/retention/pii-mask"| RET_MODULE["Retention モジュール"]
    MODULE_ROUTER -->|"/internal/{new}/*\n/v1/{new}/*"| NEW_MODULE["将来モジュール"]

    GM_MODULE --> RESP["レスポンス"]
    CAL_MODULE --> RESP
    RET_MODULE --> RESP
    NEW_MODULE --> RESP
```

---

## 4. Flow 1: Gmail Polling（定期バッチ型）

```mermaid
flowchart TD
    SCH["Cloud Scheduler\n5分毎 OIDC token"]
    EP["/internal/poll-gmail"]
    AUTH_I["Internal スキーム検証\nScheduler SA email 確認"]
    LOCK["mailboxごとにlock取得\nnamespace 1\npg_try_advisory_lock(1, hashtext(mailboxRef))\nbounded concurrency"]
    SM_GET["secret-client.js\nrefresh token 取得"]
    GMAIL_FETCH["gmail-poller.js\nHistory API差分取得\n(mailbox_ref,gmail_id)重複排除\ncheckpointはtransaction末尾で更新"]
    PII_ANON["pii-anonymizer.js\nメール本文 PII 置換"]
    AI_CALL["ai-adapter.js\nGemini API 呼び出し\n分類・返信要否・日程調整要否"]
    RAG["rag-engine.js\nFAQ embedding 検索\n返信案 context 生成"]
    SAVE["db-client.js\nemails テーブル保存\nhud_display_ready = true"]
    INBOX["event_inbox\n通知イベント追記\n（PII なし）"]
    AUDIT["audit-logger.js\ntimeline_events: mail_received\nCloud Logging: correlation_id"]
    LOCK_REL["advisory lock 解放"]
    RESP["200 OK"]

    SCH --> EP --> AUTH_I --> LOCK --> SM_GET --> GMAIL_FETCH
    GMAIL_FETCH --> PII_ANON --> AI_CALL --> RAG --> SAVE --> INBOX --> AUDIT --> LOCK_REL --> RESP

    AUTH_I -->|"SA email 不一致"| ERR1["401 即時返却"]
    LOCK -->|"lock 取得失敗\n（前回実行中）"| SKIP["200 OK (skipped)\n処理スキップ"]
```

---

## 5. Flow 2: HUD 承認 → Gmail 送信

```mermaid
flowchart TD
    HUD_ACTION["HUD ユーザー\n承認ボタン押下"]
    GW["openclaw-hud-gateway\n(IAP 検証済み)"]
    EP["/v1/mail/{mailId}/approve"]
    AUTH_H["HUD スキーム検証\naud / hd / sub 確認"]
    TOKEN_CHECK["approval-handler.js\napprovalToken 受信\nSHA-256 hash 化"]
    DB_VERIFY["db-client.js\nhash 照合\ncardVersion 確認\nsub hash 確認\ntoken_expires_at 確認"]
    STATUS_CHECK{"メール状態確認"}
    TRANSITION["emails ステータス\n未対応/pending_reply_approval → 回答済み\n（状態対応表: db_design_document.md 正本・D-47）"]
    DRAFT_SEND["gmail-poller.js\ndraft compose → send\n（副作用: Gmail 送信）"]
    TOKEN_INVALIDATE["approvalToken を\napproved に遷移\n（再利用 409 保証）"]
    AUDIT_OK["audit-logger.js\ntimeline_events: mail_approved\nmail_sent"]
    INBOX_UPDATE["event_inbox\nmail_sent 通知"]
    RESP_OK["200 OK"]

    HUD_ACTION --> GW --> EP --> AUTH_H --> TOKEN_CHECK --> DB_VERIFY --> STATUS_CHECK

    STATUS_CHECK -->|"処理済み（token consumed）"| ERR_409["409 Conflict\n（単回使用保証）"]
    STATUS_CHECK -->|"未対応 / pending_reply_approval"| TRANSITION
    TRANSITION --> DRAFT_SEND --> TOKEN_INVALIDATE --> AUDIT_OK --> INBOX_UPDATE --> RESP_OK

    DRAFT_SEND -->|"Gmail API timeout"| ROLLBACK["mail_send_operations=result_unknown\noperation marker / provider ID照合\n未送信確定時だけretry"]
```

---

## 6. Flow 3: Calendar 候補生成 → HUD 提示

```mermaid
flowchart TD
    MAIL_SCHED["Flow 1 でスケジュール変更\n依頼メールを検出"]
    EXTRACT["ai-analyzer.js\n対象期間・参加者・変更理由・制約抽出\n（抽出失敗 → 手動確認要）"]
    FREE_BUSY["calendar-planner.js\nGoogle Calendar API\n複数参加者 free/busy 取得\n（DwD + allowlist 確認）"]
    SCORE["SchedulingPolicy適用\ntimezone/duration/step/notice\nall-day/transparent/recurrence/DST\n固定tie-breakでslotId/rank決定"]
    CANDIDATE_CHECK{"3候補 生成可能?"}
    SAVE_CANDIDATES["calendar_proposals テーブル\n最大3候補保存\n予定タイトル/マスク済み本文/表示名は可\nメールアドレス・event id は保存なし"]
    SAVE_LIMITED["candidateLimitReason\n代替案（期間拡張/参加者調整/手動確認）保存"]
    INBOX_CAL["event_inbox\ncalendar_proposal 通知（非 PII）"]
    AUDIT_CAL["audit-logger.js\ntimeline_events: cal_proposed"]

    MAIL_SCHED --> EXTRACT --> FREE_BUSY --> SCORE --> CANDIDATE_CHECK

    CANDIDATE_CHECK -->|"3候補あり"| SAVE_CANDIDATES --> INBOX_CAL --> AUDIT_CAL
    CANDIDATE_CHECK -->|"候補不足"| SAVE_LIMITED --> INBOX_CAL --> AUDIT_CAL
```

---

## 7. Flow 4: Calendar 承認 → Cloud Tasks → Calendar 書き込み

```mermaid
flowchart TD
    HUD_CAL["HUD ユーザー\n候補slotIdを選んで承認"]
    EP_APPROVE["/v1/calendar/proposals/{id}/approve"]
    AUTH_H2["HUD スキーム検証"]
    TOKEN_V["approval-handler.js\napprovalToken 検証\ncardVersion / sub hash / selectedSlotId 確認"]
    AGG_CHECK["proposal_approvals 集約\n全員 approved + 同一 slotId のみ通過"]
    MANUAL_STOP["manual_review_required\nCloud Tasks enqueueなし\nクレーム保持者が手動確認"]
    SLOT_CONFLICT["selection_conflict\nCalendar 書き込みなし\n全員再投票へ"]
    OP_CREATE["calendar_operations\noperation レコード作成\nstatus: pending"]
    TASKS_ENQ["同一DB transaction\n暗号化execution plan\ncalendar_operation + outbox INSERT\n→ dispatcherがTasksへ配送"]
    RESP_ACCEPTED["202 Accepted"]

    TASKS_CB["Cloud Tasks コールバック\n/internal/calendar/operations/{id}/execute"]
    AUTH_TASK["Internal スキーム検証\nTasks SA email 確認"]
    LOCK_CAL["advisory lock 取得\nnamespace 2: Calendar operation\npg_try_advisory_lock(2, hashtext(operationId))\n（冪等性保証）"]
    ATTENDEES["calendar-worker.js\nDwD allowlist 確認\n（fail-closed）"]
    REVALIDATE["実行計画digest + 書込み直前再検証\nfree/busy・slot・revision\nETag/version・allowlist/actor\nstale → replan_required"]
    CAL_WRITE["Google Calendar API\noperation marker + version条件\n参加者ごとに冪等書き込み"]
    RESULT_SAVE["calendar_operation_results\nattendee_ref 単位で保存\n（PII なし: status / event_id / error_code）"]
    OP_DONE["calendar_operations\nstatus: succeeded / partial_failed"]
    AUDIT_DONE["audit-logger.js\ntimeline_events: cal_succeeded / cal_partial_failed\n（operationId / status / correlationId のみ）"]
    RESP_2XX["terminal/recorded結果は2xx\npre-write transientは非2xx retry"]

    HUD_CAL --> EP_APPROVE --> AUTH_H2 --> TOKEN_V --> AGG_CHECK
    AGG_CHECK -->|"manual_review_required"| MANUAL_STOP --> RESP_ACCEPTED
    AGG_CHECK -->|"pendingあり（approved間のslotId一致）"| RESP_ACCEPTED
    AGG_CHECK -->|"全員同一slotId"| OP_CREATE --> TASKS_ENQ --> RESP_ACCEPTED
    AGG_CHECK -->|"approved間でslotId不一致確定\n（全員の回答を待たず即時・D-35）"| SLOT_CONFLICT --> RESP_ACCEPTED
    TASKS_CB --> AUTH_TASK --> LOCK_CAL --> ATTENDEES --> REVALIDATE --> CAL_WRITE
    CAL_WRITE --> RESULT_SAVE --> OP_DONE --> AUDIT_DONE --> RESP_2XX

    ATTENDEES -->|"allowlist 外"| SKIP_ATT["attendee skip\n手動補正要として記録"]
    LOCK_CAL -->|"lock 取得失敗\n（同一 op 実行中）"| DUP_SKIP["200 OK（重複スキップ）"]
```

---

## 8. Flow 5: Calendar 拒否 / 候補割れ → 代替案再生成

```mermaid
flowchart TD
    HUD_REJ["HUD ユーザー\n拒否 + 拒否理由フォーム入力"]
    EP_REJ["/v1/calendar/proposals/{id}/reject"]
    AUTH_REJ["HUD スキーム検証"]
    TOKEN_REJ["approvalToken 検証"]
    AGG_REJ["aggregate_approval_status\nany_rejected に即時遷移"]
    SUPERSEDE["旧 proposal\n→ superseded に遷移"]
    REASON_SAVE["拒否入力保存\n理由コード / マスク済み理由メモ\n避けたいslotId / 希望時間帯"]
    AUDIT_REJ["timeline_events: cal_superseded"]
    RESP_REJ["200 OK"]

    EP_ALT["internal replanner\n（/alternatives は再試行用）"]
    NEW_PROPOSAL["calendar-planner.js\n拒否入力 + 他参加者の既存回答\n最新free/busy + 前回 proposal 参照\n新しい revision で再生成"]
    REVISION_SAVE["calendar_proposals\nnew revision\nparentProposalId 紐付け"]
    AUDIT_ALT["timeline_events: cal_replanned"]
    INBOX_ALT["event_inbox\n新 proposal 通知"]

    HUD_REJ --> EP_REJ --> AUTH_REJ --> TOKEN_REJ --> AGG_REJ --> REASON_SAVE --> SUPERSEDE --> AUDIT_REJ --> RESP_REJ
    AGG_REJ --> EP_ALT --> NEW_PROPOSAL --> REVISION_SAVE --> AUDIT_ALT --> INBOX_ALT
```

---

## 9. Flow 6: PII 保持期限処理（日次バッチ）

```mermaid
flowchart TD
    SCH_PII["Cloud Scheduler\n毎日 OIDC token"]
    EP_PII["/internal/retention/pii-mask"]
    AUTH_PII["Internal スキーム検証\nScheduler SA email 確認"]
    LOCK_PII["advisory lock 取得\nnamespace 3: PII retention\npg_try_advisory_lock(3, 0)"]
    QUERY["db-client.js\n90日超過レコード取得"]
    MASK["pii-retention.js\n対象フィールドをクリア/マスク\n（PII を Cloud Logging に出力しない）"]
    AUDIT_PII["audit-logger.js\nCloud Logging\n対象件数・失敗件数・correlationId のみ"]
    LOCK_REL2["advisory lock 解放"]
    RESP_PII["200 OK"]

    SCH_PII --> EP_PII --> AUTH_PII --> LOCK_PII --> QUERY --> MASK --> AUDIT_PII --> LOCK_REL2 --> RESP_PII
```

---

## 10. セキュリティ境界マップ

```mermaid
flowchart TB
    subgraph TRUST_HUD["信頼境界: HUD ユーザー"]
        H1["Google ID token\nsigned by Google"]
        H2["approvalToken plaintext\n（単回・有効期限付き）"]
    end

    subgraph TRUST_INTERNAL["信頼境界: GCP 内部サービス"]
        I1["Scheduler OIDC token"]
        I2["Tasks OIDC token"]
        I3["Gateway SA Bearer"]
    end

    subgraph OC_BOUNDARY["openclaw-api セキュリティ境界"]
        VERIFY_HUD["aud / hd / sub / exp\n全て fail-closed\n未設定 = 拒否"]
        VERIFY_INT["SA email allowlist\nScheduler SA ≠ Tasks SA\nfail-closed"]
        TOKEN_HASH["approvalToken\nSHA-256 hash のみ DB 保存\n平文は返却のみ・保存しない"]
        PII_GATE["AI 呼び出しゲート\npii-anonymizer.js 必須通過"]
        AUDIT_GATE["監査出力ゲート\nPII / secret allowlist 適用\nraw response body 禁止"]
    end

    subgraph PROTECTED["保護対象"]
        SQL_P["Cloud SQL\n（HUD からの直接接続禁止）"]
        SM_P["Secret Manager\n（レスポンス・ログ・DB に secret 非出力）"]
        GEMINI_P["Gemini API\n（PII 匿名化後のみ送信）"]
    end

    TRUST_HUD --> VERIFY_HUD
    TRUST_INTERNAL --> VERIFY_INT
    VERIFY_HUD --> TOKEN_HASH
    VERIFY_HUD --> PII_GATE
    VERIFY_INT --> PII_GATE
    PII_GATE --> GEMINI_P
    TOKEN_HASH --> SQL_P
    AUDIT_GATE --> SQL_P
    AUDIT_GATE --> SM_P
```

---

## 11. 新モジュール追加フロー

```mermaid
flowchart LR
    subgraph STEP1["Step 1 モジュール作成"]
        S1A["src/modules/{name}/\n  routes.js\n  {name}-service.js\n  approval-handler.js（必要時）"]
        S1B["migrations/{name}/\n  001_schema.sql"]
    end

    subgraph STEP2["Step 2 Core 層ルール確認"]
        S2A["db-client.js 経由で DB アクセス"]
        S2B["pii-anonymizer → ai-adapter の順で AI 呼び出し"]
        S2C["audit-logger.js で timeline_events 追記"]
        S2D["advisory lock namespace を feat:{name}-* に設定"]
    end

    subgraph STEP3["Step 3 ルーター登録"]
        S3["api-server.js に\nrequire('./modules/{name}/routes')\nの1行追加のみ"]
    end

    subgraph STEP4["Step 4 インフラ追加（Terraform 側）"]
        S4A["Cloud Scheduler ジョブ追加（バッチ型）"]
        S4B["Cloud Tasks キュー追加（非同期型）"]
        S4C["新 OAuth scope が必要な場合のみ\nOAuth 再同意フロー設計"]
    end

    STEP1 --> STEP2 --> STEP3 --> STEP4
```

---

## 12. ディレクトリ構成

```
openclaw-api/
  src/
    api-server.js
    core/
      auth-middleware.js
      db-client.js
      ai-adapter.js
      pii-anonymizer.js
      audit-logger.js
      secret-client.js
    modules/
      gmail/
        routes.js
        gmail-poller.js
        ai-analyzer.js
        rag-engine.js
        approval-handler.js
      calendar/
        routes.js
        calendar-planner.js
        calendar-worker.js
        approval-handler.js
      retention/
        routes.js
        pii-retention.js
      {new-feature}/
        routes.js
        {new-feature}-service.js
  migrations/
    gmail/
      001_emails.sql
      002_faq_entries.sql
      003_sent_reply_embeddings.sql
    calendar/
      001_calendar_proposals.sql
      002_calendar_operations.sql
      003_calendar_operation_results.sql
    {new-feature}/
      001_schema.sql
```
