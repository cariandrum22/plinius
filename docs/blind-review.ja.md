# ブラインド人手レビュー（日本語）

Plinius は、完了した実験の実行記録（canonical run records）から**再現可能な
ブラインドレビュー資料**を生成できます。人手評価をモデル名・実行環境・自動評価
結果から独立させ、ルーブリックとベンチマークを較正することが目的です。

## アーキテクチャ境界

ブラインドレビューのデータは **派生成果物**です。canonical run records は
一切変更しません。

```
canonical run records
      ↓ blind create
公開パケット(public/) ＋ 非公開マッピング(private/)
      ↓ 人手採点
      ↓ human-review import
検証済み人手レビュー(reviews/)
      ↓ human-review unblind / report --unblind
アンブラインド・評価比較
```

公開パケットと非公開マッピングは**常に別ファイル**です。

## 生成

```bash
plinius blind create --experiment <実験ID> --config benchmark/blind-review/baseline-calibration.yaml
```

生成物のレイアウト:

```
benchmark/artifacts/blind-review/<review-set-id>/
  public/                     # レビュアーに渡してよい
    review-set.json
    review-guide.ja.md
    scoring-sheet.json
    items/R-XXXXXXX.md
    pairwise/                 # pairwise 有効時のみ
  private/                    # 絶対に共有しない
    mapping.json              # blindId ↔ モデル/ターゲットの対応
    generation-manifest.json  # seed 等の再現メタデータ
  reviews/                    # 取り込んだ人手レビュー（ブラインド）
  reports/                    # 生成した分析レポート
```

### レビュアーに渡してよいファイル / 渡してはいけないファイル

- **渡してよい**: `public/` 配下のみ（review-guide.ja.md, items/*.md, scoring-sheet.json など）
- **渡してはいけない**: `private/` 配下（mapping.json, generation-manifest.json,
  unblinded-reviews.json）。ここには blindId とモデル identity の対応や seed が
  含まれます。

公開アーカイブは `private/` を構造的に除外して生成されます。

## 採点方法

各 `public/items/R-XXXXXXX.md` を読み、以下を判断します（詳細は
`review-guide.ja.md`）:

- 各評価軸（正確性・完全性・指示遵守・内部整合性・明瞭性・実用性・要件忠実度）を
  0–5 で採点
- 指摘事項（重大度: minor / major / blocking）
- 総合点（0–5）、採用可否（qualified / not_qualified / inconclusive）、評価確信度（0–1）
- **ブロッキング指摘があれば採用可否は not_qualified と整合させる**

正式な取り込み形式は JSON（`HumanReviewRecord`）です。`scoring-sheet.json` を
雛形として使えます。

## 取り込み

```bash
plinius human-review import --review-set <id> --input reviews.json
# 既存レビューを更新する場合は --update
```

検証内容: スコアの範囲・刻み、rubric バージョン一致、blindId の存在、
ブロッキング↔採用可否の整合、重複（reviewer×blindId）拒否。

## 対比較（ペアワイズ）

config で `pairwise.enabled: true` にすると、同一課題に対する2回答（A/B）の比較
パケットが生成されます。A/B の割り当ては無作為化され、対応は private マッピング
にのみ保存されます。既定では同一モデル同士のペアは避けます。

## アンブラインド

モデル identity との結合は**明示的な操作**が必要です。

```bash
plinius human-review unblind --review-set <id>          # private/unblinded-reviews.json を生成
plinius human-review report --review-set <id> --unblind # モデル別・評価器比較を含むレポート
```

`inspect` と `report`（`--unblind` なし）は blindID のみを表示し、モデル identity を
一切明かしません。

## 不一致指標の読み方

- **レビュアー間一致 / 総合点の平均絶対差**: 低いほど基準の解釈がばらついている
  →ルーブリック定義の見直し候補。
- **決定的評価との比較**: 誤合格率（人間=合格・決定的にブロッキング失敗）や
  致命的欠陥見逃し率が高い場合、人手基準か決定的チェックのどちらかに問題。
- **LLM審査との比較**: 総合点MAE・順位相関で、審査モデルの妥当性を確認。

結果は既定で単一スコアに統合しません。品質・信頼性・一致度を分けて見ます。

## 最初のレビューセットをモデル合否に使わない理由

現在の6ベンチマークは **prototype** です。したがって最初のレビューセットは
`purpose: rubric-and-benchmark-calibration` / `exclude_from_model_qualification: true`
としており、**ルーブリックとベンチマーク自体の較正**が目的です。この段階の人手
スコアでモデルの正式な合否を決めると、未成熟な基準でモデルを評価することになり
ます。基準が安定してから、本番ベンチで合否判定を行ってください。

## セキュリティ・プライバシー

- マッピングは公開パケットと分離。
- 環境変数・APIキー・認証情報は成果物に含めません。
- ソースのファイルシステムパスや Git リモートURLは含めません。
- 公開アーカイブ生成は `private/` を除外します（テストで保証）。
