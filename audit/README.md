# テスト

プロジェクトのルートで次を実行すると、Apps Script本体・Chrome拡張機能・画面の回帰テストを実行します。

```sh
pnpm test
```

Node.jsだけで実行する場合：

```sh
TZ=Asia/Tokyo node audit/run-tests.cjs
```

テストは架空の学生番号・授業・担当者・課題・メールと `.invalid` ドメインのリンクを使います。Googleアカウント、Gmail、Drive、本番スプレッドシートへ接続しません。

- `server-tests.cjs`：メール分解、誤完了防止、期限・保存処理。
- `extension-tests.cjs`：送信分割、プレビュー、Classroomの読み込みと同期。
- `ui-tests.cjs`：画面更新の競合、完了操作、期限区分と設定。
- `deadline-cases.cjs`：63通りの曜日・期限差と、週境界・月末・年末・閏日などの期待値。

ブラウザーで確認する場合は [`local-dev/README.md`](../local-dev/README.md) を参照してください。テストケースExcelの取込スモークテストには `@oai/artifact-tool` が必要です。実行環境にない場合は回帰テストを実行し、Excel取込部分を明示的にスキップします。
