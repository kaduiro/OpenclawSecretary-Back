# Backend Use Case List: Gmail AI Secretary

## 実装との関係（2026-07-16）

この一覧は受入れ対象のUse Caseを示し、各項目の実装完了を示すチェックリストではない。現在の成立範囲は[現行実装ベースライン](../../implementation/current-implementation.md)、残作業は[tasks.md](tasks.md)を参照する。AI/RAGを含むBE-UC-003/015、freeBusy plannerを含むBE-UC-007/016/017/018、Domain-wide Delegationを前提とする経路は未実装または部分実装である。

作成日: 2026-06-25 | 更新日: 2026-07-15 (D-37〜D-46) | ステータス: DRAFT

| UC | Backend Responsibility |
|---|---|
| BE-UC-001 | strict loopback OAuth callbackを処理し、未登録個人userをprovisioning作成してSecret保存成功後だけactive化する |
| BE-UC-002 | HUD heartbeat / health API に安全な readiness 情報だけを返す |
| BE-UC-003 | mailbox別History checkpointでGmail差分を取り込み、非信頼入力境界を通してAI/RAG返信案を生成する |
| BE-UC-004 | HUD 承認カード取得 API に、PII と secret の境界を守った payload を返す |
| BE-UC-005 | Gmail 返信承認を検証し、重複送信を避けて副作用を実行する |
| BE-UC-006 | Gmail 返信拒否を検証し、状態遷移と監査イベントを保存する |
| BE-UC-007 | Calendar 候補を生成し、予定タイトル・マスク済み予定本文・参加者表示名を含む候補表示情報を HUD に返す。メールアドレス・Google event id・calendar id・会議URL・token は返さない |
| BE-UC-008 | 暗号化Calendar execution planとoutboxをtransaction作成し、dispatcher/Cloud Tasks workerで再検証・冪等実行する |
| BE-UC-009 | Calendar 部分失敗を attendee ref 単位で記録する |
| BE-UC-010 | FAQ 候補を PII 除去確認後に登録する |
| BE-UC-011 | 設定値を読み取り、DwD allowlist missing / empty / null を fail-closed として扱う |
| BE-UC-012 | 重大障害を event inbox と `timeline_events` に記録する |
| BE-UC-013 | PII retention job を日次実行し、ログに PII を出さない |
| BE-UC-014 | SQLite など旧データの Cloud SQL 移行をバックエンド migration として扱う |
| BE-UC-015 | スケジュール変更依頼メールから、対象期間、参加者、変更理由、制約条件を抽出する |
| BE-UC-016 | 複数参加者の対象期間内の空き状況を取得し、全員が参加可能な候補日時を探索する |
| BE-UC-017 | SchedulingPolicyに従い決定的slotId/rankと設定済みcontext windowを生成する |
| BE-UC-018 | 優先度の高い予定の直前または直後にある候補は順位を下げ、最大3候補を HUD 表示用に整形する |
| BE-UC-019 | HUD に3候補、原因メール、メール本文、候補ごとの全参加者の前後予定コンテキストを返す |
| BE-UC-020 | 対象期間内で3候補を満たせない場合、候補不足理由を明示し、期間外候補・期間拡張・参加者調整・手動確認の代替案を提案する |
| BE-UC-021 | 全参加者が同一 slotId を承認した後だけ Calendar operation を作成し、Cloud Tasks worker でスケジュール変更を実行する |
| BE-UC-022 | HUD が候補を拒否した場合、拒否理由フォーム入力と前回 proposal・他参加者の既存回答・最新 Calendar 空き状況を使って即時に次の proposal revision を作成する |
| BE-UC-023 | 管理外必須参加者がいる場合、管理内参加者の空き状況だけで候補を生成し、proposal を `manual_review_required` で停止し、管理外参加者には approvalToken / event_inbox を発行せず、クレーム保持者向けの手動確認テキストを HUD に表示する |
| BE-UC-024 | personal owner／BU member／current claimant／proposal participant／Admin SAのresource authorizationを強制する |
| BE-UC-025 | BU共有mailをclaimした時だけclaimantへ初回approvalToken/draft accessをbindし、解除・移譲・timeoutで失効する |
| BE-UC-026 | Gmail send operation ledgerを照合し、response loss後も二重送信せず成功／不明結果へ収束する |
| BE-UC-027 | AI失敗・unsafe output・bounceをapproval_readyと区別したcard variantとして返す |
| BE-UC-028 | event inbox、FAQ候補、暗号化draft/plan、provider IDを分類ごとの期限で削除／仮名化する |
