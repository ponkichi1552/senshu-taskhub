# 開発・改修履歴

課題通知Hub / TaskHub for Senshu University の主要な設計変更、機能追加、修正、検証を時系列で記録します。現在の仕様と利用方法は[README](./README.md)を参照してください。

> 詳細な変更記録は、README / CHANGELOG整理直前の[CHANGELOG](https://github.com/ponkichi1552/senshu-taskhub/blob/97895df64e16aae783106513bf0531617b61ab12/CHANGELOG.md)に保存しています。以下では、主要な設計変更を追いやすい単位にまとめています。

## 2026-10-10 README / CHANGELOGの全面整理

READMEを現在のmain実装、Chrome拡張機能、Google権限、表示データ構成、CI/CDに合わせて更新しました。CHANGELOGは主要な設計変更と検証を時系列で追える構成に整理し、更新前の詳細版は上記コミットのファイルに残しています。

## 2026-10-09 保存後の表示生成を軽量化

- [97895df](https://github.com/ponkichi1552/senshu-taskhub/commit/97895df64e16aae783106513bf0531617b61ab12)：inCampusだけが更新された時に、同期で準備したClassroom由来の表示入力を条件付きで再利用するようにしました。入力の欠落、破損、世代不一致、同期中、容量超過などを検出した場合は通常のシート読込へ戻します。
- [1e222fc](https://github.com/ponkichi1552/senshu-taskhub/commit/1e222fcf9827b260889c80b702509ad07b3d1ddd)：表示結果を指紋化し、内容・件数が同一なら表示用シートの再書き込みを省きました。状態世代やスキーマが一致しない場合は再利用しません。
- [9053815](https://github.com/ponkichi1552/senshu-taskhub/commit/90538152d2dc45c4bc7be851af2ba7da848268df)・[2435629](https://github.com/ponkichi1552/senshu-taskhub/commit/2435629bef64464cf68440eac9b60b0cb27df7a9)：手動送信の変更なし表示、重複POSTの抑止、古い保存応答が新しい抽出状態を上書きする問題を修正しました。

## 2026-10-09 Chrome拡張機能 v2.5.13〜v2.5.16

- 実際のinCampus構造に合わせてDOM抽出を再検証し、課題本文の改行を保持し、画面に表示されている添付名だけを取得します。
- 非表示の保存パス、検査状態、提出済み成果物を課題本文に混ぜないようにしました。項目名は部分一致でなく完全一致で照合します。
- ログイン画面への遷移、通信失敗、15秒の読取タイムアウトを検出します。詳細取得は最大4並列、複数タブ同期は排他制御します。
- SheetsのDate値と送信日時文字列の同値比較、変更なしの正確な表示、重複POST抑止、古い保存応答の保護を加えました。
- 24:00は記載日の23:59、00:00は前日の23:59として扱います。境界と再送条件を仮想データで検証しました。

関連コミット：[892a238](https://github.com/ponkichi1552/senshu-taskhub/commit/892a23859e152be54199961b5428ca5eda32464a)、[325776c](https://github.com/ponkichi1552/senshu-taskhub/commit/325776c2ca78ac2d8d4aa48c71eae2907f4462f4)、[9053815](https://github.com/ponkichi1552/senshu-taskhub/commit/90538152d2dc45c4bc7be851af2ba7da848268df)。拡張機能のManifest上の現在のバージョンは2.5.16です。

## 2026-10-09 初期表示と完成済み全件一覧を再設計

- [707a804](https://github.com/ponkichi1552/senshu-taskhub/commit/707a804e889af0fa6906abe561d3aa5499707867)・[8f104c2](https://github.com/ponkichi1552/senshu-taskhub/commit/8f104c2eeb9e7adf6ca50f525eed50e17b51315e)：ホーム、課題一覧、大学通知一覧の先頭カードと必要な集計を初期HTMLに含め、先頭表示と残りの読込を分けました。既読・保存などの操作を古い応答で取り消さないようにしました。
- [fed34d0](https://github.com/ponkichi1552/senshu-taskhub/commit/fed34d07f065567e84719e433dcfd750e265ba64)・[2e59994](https://github.com/ponkichi1552/senshu-taskhub/commit/2e59994bc077d82e1c2e4ded32b334e12e031480)：大学通知をホーム表示後に先読みし、課題・完了課題・大学通知の軽量な全件一覧を圧縮スナップショットにしました。
- [2e59994](https://github.com/ponkichi1552/senshu-taskhub/commit/2e59994bc077d82e1c2e4ded32b334e12e031480)：A/B領域へ交互に書き、完成・検証した新世代だけを公開します。同期失敗や途中終了では直前の完成済み一覧を維持し、容量条件を満たさない場合は通常の読込経路へ戻します。
- [2aa9c02](https://github.com/ponkichi1552/senshu-taskhub/commit/2aa9c02af0e090b2b4f401db15161a2f34a72098)：起動時の初期表示データを、完了履歴の件数とは独立した容量条件で扱います。

2026年10月9日の一時点では、ホーム表示が約1.93秒、ホームから課題通知への移動が約0.32秒でした。キャッシュなしの改修前表示は約4.53秒でした。測定条件は完全には同一でないため、これらは特定時点の参考値であり、常時の性能保証ではありません。

## 2026-10-08 CI/CDとGitHub構成を整理

- [50fd3b6](https://github.com/ponkichi1552/senshu-taskhub/commit/50fd3b68d48b11f972ac7cdc4118eacfa27d243c)：push・pull request・手動実行で回帰テストを行うGitHub Actions CIを追加しました。Node.js 24、pnpm 11.19.0、固定lockfileを使い、workflowのcontents権限はreadに限定します。
- [67814da](https://github.com/ponkichi1552/senshu-taskhub/commit/67814da97b4456c6b4df29ebb780f2151cea0fcb)：テスト成功後にproduction Environmentの承認を経てApps Scriptを更新するCI/CDを追加しました。既存deployment IDを使ってWebアプリURLを維持し、認証情報はEnvironment Secret、IDはEnvironment Variablesで管理します。
- [0157c1e](https://github.com/ponkichi1552/senshu-taskhub/commit/0157c1e5177db032f102d5ebbd0d5a7fc0542174)：Apps Scriptの完全ミラーをGitHubから削除し、taskhub-split/taskhub-split/を唯一の正本にしました。
- 通常利用者向けREADMEを、本番Webアプリから始められる手順へ変更しました。開発者向けのclasp操作はローカル開発文書へ分けています。

## 2026-10-07 表示処理を同期時の事前生成へ移行

ホームや一覧を開くたびに元メールや全課題を再解析する方式を見直しました。同期時に課題・完了課題・大学通知の表示データを生成し、キャッシュがない時も準備済みシートから読める構成へ移しました。大学通知の一覧と本文を分け、本文は選択時だけ取得し、全文検索はサーバー側で行います。

同期や一覧生成が重なった場合も、公開済みの完成データを維持し、取得失敗や途中終了で不完全な一覧を表示しないようにしました。先頭表示用HTML、世代管理、画面間での一覧読込共有を段階的に追加しました。

## 2026-10-05 Classroom APIを課題・提出状態の基準へ変更

Classroom APIから参加授業、公開課題、本人の提出状況を取得し、正式な締切や提出状態の基準としました。Gmailは15分ごとの新着通知やAPIにないお知らせ・資料・返却通知の補完に残し、API反映前の通知も先行表示します。曖昧な照合では別データとして保持します。

Classroom提出状況の個別取得を授業単位の一括取得へ変更しました。2026年10月5日の特定検証では39課題に対するAPI呼び出しが39回から4回、提出状況取得時間が6,040msから856msになりました。対象39課題の旧方式・新方式の取得結果は一致しました。この計測は特定実行に限り、同期全体や将来のAPI応答時間を保証しません。

## 2026-10-03 テスト基盤・仮想日時・増分同期・コード分割

Classroom API、Gmail、inCampusの照合や締切境界を、架空データで再現する回帰テストを拡充しました。仮想日時を導入し、期限・保存期間などの境界を実時間に依存せず検証できるようにしました。

Gmail同期を増分化し、手動更新を非同期化しました。Apps Script本体を責務ごとに分割し、ローカルで実コードを動かすテストハーネスと開発手順を整備しました。

主なコミット：[28b8829](https://github.com/ponkichi1552/senshu-taskhub/commit/28b88292d0596bd4cea5044efd11d4358e41cd28)、[2f5b07d](https://github.com/ponkichi1552/senshu-taskhub/commit/2f5b07db90052e496d7def6f235fc0d40f037e36)。

## 2026-09-27 Gmail同期の競合と性能を改善

Gmail検索を長時間の共有ロックの外へ移し、同時表示や複数タブでの同期が互いを長く待たせる問題を改善しました。不要な書き戻しを減らし、同期と表示処理の競合を抑えました。

## 2026-09-12 データモデルと大学通知を再設計

Gmail通知を基準にしていたデータモデルを監査し、inCampus通知の分類・保存と大学からのお知らせ表示を整理しました。大学通知の未読・保存状態を利用者ごとに管理し、本文と表示一覧の保存方法を見直しました。

## 2026-08〜07 テスト・安全性・保存処理を拡充

仮想データによる回帰確認、inCampus課題詳細の抽出、重複判定、書き込み競合の抑制、APIトークン検証、受信データ検証、利用者ごとの保存先自動作成を追加しました。提出状態や期限境界を保護するテストも拡充しました。

## 2026-07 課題管理と画面を拡張

期限別一覧、ホーム画面、課題完了状態の管理、inCampus通知の取り込みを追加しました。単一スクリプトから機能別のファイルへ分割し、一覧ツールから継続利用できるWebアプリへ発展しました。

## 2026-06 企画の再設計と最初のMVP

授業情報を横断して確認する課題管理を中心に企画を再設計しました。Gmail通知を整理する初期案からWebアプリを先に作り、授業・課題の一覧、期限表示、更新処理を備えた最初のMVPを構築しました。

## 現在の基準

- Apps Script Webアプリの正本：taskhub-split/taskhub-split/
- Chrome拡張機能：v2.5.16、inCampus専用
- Classroomの課題・提出状態：Google Classroom API
- 通知・先行表示・補完：Gmail
- inCampusの画面情報：Chrome拡張機能
- CI：push・pull request・workflow_dispatchでpnpm test
- 本番デプロイ：テスト成功後、production Environment承認を経て既存deployment IDを更新
