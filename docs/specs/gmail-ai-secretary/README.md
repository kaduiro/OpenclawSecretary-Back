# Gmail AI Secretary Backend Docs

このディレクトリはGmail AI Secretaryバックエンドの要件・設計文書を保持する。現在の実装状況は`../../implementation/current-implementation.md`を参照する。

## 正本

- `../../api/openapi.yaml`: API contract
- `requirements_definition.md`: 要件
- `design.md`: 目標設計
- `process_flow_design.md`: 処理フロー
- `UseCase_List.md`: Use Case
- `db_design_document.md`: 論理DB設計。実装済みschemaは`../../../migrations/*.sql`を優先
- `../../security/security_design.md`: セキュリティ設計
- `../../architecture/modular-monolith-architecture.md`: アーキテクチャ

## 実装・検証

- `../../implementation/current-implementation.md`: 実装済み、部分実装、未実装の区分
- `tasks.md`: 実装状況と残作業
- `test_plan.md`: テスト計画
- `validation_report.md`: 最新検証結果

## 補助文書

- `db_columns_list_with_relations.md`: 論理カラム一覧。物理schemaとの差分はmigrationを優先
- `er_diagram.md`: 論理ER図

## 履歴

`history/`は意思決定過程を保存する参照専用文書であり、現行実装の正本として使用しない。
