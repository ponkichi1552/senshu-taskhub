# TaskHub開発とApps Script更新

このフォルダーには、Apps Script本体、workspaceミラー、Chrome拡張機能、架空データのテストExcel、ローカル検証環境をまとめています。

## ソース構成

- `taskhub-split/taskhub-split/`：Apps Scriptの正本。Gmail同期、Classroom API、通知処理、画面テンプレートを含みます。
- `taskhub-split/workspace/taskhub-split/`：正本のミラー。回帰テストで一致を確認します。
- `taskhub-split/classroom-api-experiment/`：APIだけを試す別Apps Scriptプロジェクトと専用テスト。
- `taskhub-extension-v2.5/`：Chrome拡張機能。
- `test-fixtures/TaskHub-test-cases.xlsx`：授業・担当者・課題・メール・リンクがすべて架空のテストデータ。
- `audit/` と `local-dev/`：回帰テスト、ローカルWeb画面、Googleサービスの模擬環境。

## ローカル検証

```sh
pnpm install --frozen-lockfile
pnpm test
```

テストはApps Scriptの実コード、Chrome拡張機能、画面の期限分類を使います。通常の回帰テストはGoogleアカウントや本番データに接続しません。Excelの取込スモークテストには `@oai/artifact-tool` が必要です。ローカル画面の起動方法とテストケースの使い方は [`local-dev/README.md`](./local-dev/README.md) を参照してください。

## Apps Scriptへの反映

`.clasp.json` はプロジェクトごとのローカル設定として管理し、リポジトリには含めません。OAuth資格情報、APIトークン、実際のメールや課題データもコミットしないでください。

反映前に変更一覧を確認し、回帰テストを通します。

```sh
pnpm exec clasp show-file-status
pnpm test
pnpm exec clasp push --force
pnpm exec clasp version "変更内容と日付"
pnpm exec clasp update-deployment <既存deployment-id> --versionNumber <作成したversion> --description "変更内容と日付"
```

`clasp push` はApps Scriptプロジェクト内のファイルをまとめて更新します。既存deployment IDで更新するとWebアプリURLを保てます。新規URLが必要な場合だけ別deploymentを作成してください。デプロイ後はApps Scriptの実行履歴とトリガー一覧を確認し、本番URLを開いて実動作を確かめます。

本番同期は利用者本人のアカウントで実行します。Gmailは15分ごと、Classroom APIは1時間ごとに動作し、利用者がアプリを開いた時に自分の定期トリガーを更新します。
