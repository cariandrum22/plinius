# オンライン・フロンティア評価キャンペーン（日本語）

Plinius は、ローカル vLLM ターゲットに加えて **OpenRouter 経由の現行フロンティア
モデル**を評価できます。OpenRouter は変化が速いため、カタログ同期・不変スナップ
ショット・明示的コホート選択・再現可能な canonical 解決を前提に設計しています。

## 概念の分離

以下は別物として扱います:

1. モデルファミリ
2. canonical モデル slug
3. 可変エイリアス（`~author/model-latest` など）
4. プロバイダエンドポイント
5. 推論プロファイル（reasoning 設定）
6. 実験ターゲット
7. ベンチマークコホート

**モデルと推論設定は同一の評価対象ではありません。** 例えば標準 reasoning と
pro reasoning は、同じ論理モデルを共有する**別ターゲット**です。

## 1. カタログ同期

```bash
plinius models sync --backend openrouter          # ライブ（OPENROUTER_API_KEY 任意）
plinius models sync --fixture <path>              # オフライン（スナップショット生成のみ）
plinius models list --sort intelligence-high-to-low --min-context 131072
plinius models inspect moonshotai/kimi-k3
plinius models diff <snapshot-a.json> <snapshot-b.json>
plinius models recommend
```

- raw API 応答と**正規化スナップショット**を別ファイルで保存
  （`benchmark/artifacts/catalog/<snapshotId>.raw.json` と `<snapshotId>.json`）。
- 正規化カタログは独立した `schema_version` を持ちます。
- **既存スナップショットの解析に API キーは不要**です。
- `snapshotId` は正規化モデルの内容ハッシュで、取得時刻に依存しません
  （同一 raw → 同一 snapshotId、再現可能）。
- 同期は実験・コホート定義を**改変しません**。

`list` のフィルタ: newest / intelligence / most-popular / context / pricing、
required parameters・入出力モダリティ・author・最大価格・最小コンテキスト・ZDR。

## 2. エイリアス解決と再現性

実行前に:

1. エイリアスを現在の canonical slug に解決
2. 要求エイリアスと解決 canonical slug の**両方**を保存
3. スナップショット ID・解決時刻・モデル作成日を保存
4. プロバイダ・ルーティング制約を保存
5. 応答が返した実モデルを保存し、不一致は**評価警告**として記録

これにより、エイリアスが後日新しいモデルを指しても、完了済み実行の意味は保たれます。

## 3. コホート（`benchmark/campaign/cohorts/`）

- **A: frontier-ceiling-2026-07** — 品質上限コホート（Kimi K3, GPT-5.6 Sol, Claude Fable 5,
  `~claude-sonnet-latest`（canonical解決必須）, Gemini 3.1 Pro Preview, Grok 4.5）
- **B: open-weight-cost-frontier-2026-07** — 低コストでフロンティアに迫る候補
- **C: coding-specialists-2026-07** — コーディング特化＋動的発見（人手確認必須）
- **D: fiction-specialists-exploratory** — 創作特化（探索的、Aion 3.0/Mini 候補）

コホート所属は**人手レビューとバージョン管理**が必須。発見ルールは
**提案**を生成するのみで、pinned モデルを黙って置き換えません。

## 4. 推論プロファイル（`profiles.yaml`）

`neutral-baseline` / `high-reasoning` / `maximum-reasoning` /
`deterministic-where-supported` / `fiction-controlled`。

送信前に各ターゲットの `supported_parameters` と照合します。
**未対応パラメータを黙って適用扱いにはしません。** ポリシー（設定・永続化）:

- `reject`: ターゲット/プロファイルの組合せを却下
- `omit`: 未対応パラメータを省略し記録
- `mark_not_comparable`: 実行は残すが「比較不可」と印

推論は正規化プロファイルと**厳密なプロバイダ要求の両方**を保存し、要求 effort・
受理 effort・reasoning トークン・返却有無・除外有無・警告を記録します。
最小 reasoning と最大 reasoning を同等として比較しません
（fixed-budget 比較 と best-supported-quality 比較の両方を生成）。

## 5. プロバイダルーティング

- **再現性モード**: 単一エンドポイントに固定、明示許可がない限りフォールバック拒否、
  プロバイダ/量子化/ルーティング設定を保存。
- **可用性モード**: フォールバック許可、実プロバイダとフォールバック事象を記録。
  再現性モードの結果と**混在させない**。

実プロバイダが不明な場合は provenance を「不完全」と印。異なる量子化の
エンドポイント間で bit-for-bit 同等とは主張しません。

## 6. コスト・予算（`budget.yaml`）

各実行で prompt/completion/reasoning/cached/native トークン、list 価格見積、
実 OpenRouter 生成コスト（取得可能時）、request/generation ID、
cost-per-benchmark / passing / qualified / quality-point を保存。
**コストと品質は分離**し、既定で単一の品質/コスト合成スコアは作りません。

予算: `maximum_total_usd` / `maximum_per_target_usd` / `maximum_per_run_usd` /
`stop_on_budget_exhaustion`。実行前に最小・期待・上限コストを見積もり、
**上限が予算超過なら明示的承認が必要**。予算枯渇は**モデル失敗ではなく**制御事象
として分類します。

## 7. 3段階実行計画

1. **Stage 1 プロトコル・スモークテスト** — 各ターゲットに安価なベンチ1件。可用性・
   パラメータ対応・応答解析・reasoning/usage メタ・provider provenance・コスト取得・
   finish reason・コンテンツフィルタ挙動を確認。
2. **Stage 2 スクリーニング** — 6 prototype ベンチ・2 反復・neutral。壊れた設定や
   ベンチ飽和/床効果・過剰拒否・出力形式非互換・極端コストを検出。
3. **Stage 3 較正キャンペーン** — Stage 2 の人手レビュー後にのみ。承認済みベンチ・
   5 反復・neutral + high-reasoning・**日本語ブラインドレビュー**生成。
   prototype / infrastructure-validation の結果は qualification から除外。

## 8. 人手レビュー統合

ブラインドパケットはモデル名・提供元・価格・reasoning モード・レイテンシ・
トークン数・ファミリ・OpenRouter 順位・ベンチスコア・ルーティングモードを
**一切露出しません**。自己言及漏洩（「I am Kimi」「As Claude」等）は既存の
leakage ポリシーに従い、較正パケットでは `exclude` を用い、除外率を
**指示遵守指標**として追跡します。

## 9. 発見レポート

```bash
plinius models recommend
```

新規追加・上位 intelligence・上位 coding/agentic・高利用・失効/非推奨・
エイリアス差異・価格変更・コンテキスト変更・対応パラメータ変更・
エンドポイント変更・候補追加/削除と**各推奨の理由**を、透明なルールと出典メタ
付きで提案します（コホートは自動改変しません）。**人気だけを品質signalにしません。**

## 10. 初期ライブターゲット（設定検証のみ）

Kimi K3 を含む12 slug（`moonshotai/kimi-k3` ほか）は、現行カタログスナップショットに
対して解決できることを確認済みです。**明示的な予算設定なしに全キャンペーンを実行
しないでください。**

## データ保持（ZDR）

`require_zdr: true` のキャンペーンは ZDR エンドポイントを要求します。機密データを
含むベンチでは、明示的 override がない限り非 ZDR ターゲットを却下します。初期
prototype スイートに機密データは含まれません。
