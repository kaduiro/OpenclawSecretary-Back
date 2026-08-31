# OpenclawSecretary-Back Docs

このディレクトリはOpenclawSecretaryバックエンドのAPI契約、現行実装、要件、設計、セキュリティ、DB、テスト文書を保持する。

2026-07-20時点のproduction判定は`BLOCKED`である。ローカルbaselineは成功しているが、現在のrelease blockerと受入状態は`reviews/review-register.md`を参照する。文書ごとに別の未解決一覧を作らない。

## 最初に読む文書

1. `reviews/review-register.md`: 3リポジトリの固定レビュー基準、指摘ID、現在状態
2. `reviews/front-terraform-remediation-plan.md`: Front/Terraform指摘の対応順序、実装境界、受入条件
3. `implementation/current-implementation.md`: 現在実装されている範囲と未実装項目
4. `api/openapi.yaml`: API契約の正本
5. `specs/gmail-ai-secretary/requirements_definition.md`: バックエンド要件
6. `specs/gmail-ai-secretary/design.md`: 目標設計
7. `security/security_design.md`: アプリケーションセキュリティ

## 正本

| 対象 | 正本 |
|---|---|
| API | `api/openapi.yaml` |
| DB schema | `../migrations/*.sql` |
| 現行動作 | `../src/`と`implementation/current-implementation.md` |
| 要件 | `specs/gmail-ai-secretary/requirements_definition.md` |
| セキュリティ | `security/security_design.md` |
| Infrastructure | Terraform repository |

3リポジトリのレビューは`契約`、`認証・認可`、`データ整合性・PII`、`可用性・運用`、`供給網・CI`、`テスト・文書`の6観点に固定する。

設計書とmigrationが異なる場合、実装済みDBについてはmigrationを優先する。将来要件と現行実装が異なる場合は、現行実装ベースラインの「未実装・部分実装」を参照する。

## 文書一覧

- `architecture/modular-monolith-architecture.md`: モジュール構成と主要フロー
- `security/security_design.md`: 認証、認可、暗号、PII、監査
- `specs/gmail-ai-secretary/process_flow_design.md`: 業務処理フロー
- `specs/gmail-ai-secretary/db_design_document.md`: 論理DB設計
- `specs/gmail-ai-secretary/test_plan.md`: 目標テスト計画と実施状況
- `specs/gmail-ai-secretary/tasks.md`: 実装済み項目と残作業
- `specs/gmail-ai-secretary/validation_report.md`: 最新検証結果
- `specs/gmail-ai-secretary/history/`: 意思決定・レビュー履歴。現行仕様の正本ではない
- `reviews/review-register.md`: 現行レビュー指摘の唯一の台帳。過去レビューではなく、この状態を更新する
- `reviews/front-terraform-remediation-plan.md`: Front/Terraform指摘の推奨対応方式、PR順序、release gate

## 対象外

HUD画面設計とTerraform resource定義はこのリポジトリの正本ではない。ここでは、それらと接続するAPI contract、環境変数、IAM前提だけを管理する。
