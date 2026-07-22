/**
 * Japanese reviewer-facing Markdown rendering.
 *
 * Markdown is for human readability only; JSON remains the canonical import
 * format. The original model answer is shown as-is and is never auto-translated;
 * an optional reference translation, when supplied externally, is shown in a
 * clearly-marked, non-scored field (参考訳（採点対象外）).
 */
import {
  BlindReviewItem,
  BlindReviewSet,
  PairwiseItem,
  PairwiseReviewSet,
} from "./schema.js";

/** The Japanese reviewer guide. */
export function renderReviewGuideJa(set: BlindReviewSet): string {
  return `# ブラインドレビュー実施ガイド

このパケットは **${set.reviewSetId}** の人手評価用資料です（ロケール: ${set.locale}）。

## このレビューの目的

各回答が各ドメインで専門家水準に達しているか、そしてどの評価軸が弱いかを
人手で判定します。用途: **${set.purpose}**。
${set.excludeFromModelQualification ? "> ⚠ この評価セットは **モデルの正式な合否判定には使用しません**（ルーブリック／ベンチマークの較正用）。\n" : ""}
## 重要な原則

- **モデルの正体は意図的に隠されています。** どのモデル・提供元・実行環境かを
  推測しないでください。ID（例: \`R-7K3M9Q\`）は無意味な識別子です。
- **外部の自動評価結果（決定的チェックやLLM審査）を参照してはいけません。**
  人手評価はそれらから独立している必要があります。
- **文体の好みと正しさを混同しないでください。** 好みではなく、正確性・要件充足で
  採点します。
- **参照解答は品質の目安であり、唯一の正解ではありません。** 別解でも要件を
  満たしていれば高評価となり得ます。

## 採点尺度（0–5）

各評価軸を 0〜5 の整数で採点します。

- 5: 専門家水準。実務でそのまま採用可能。
- 4: 良好。軽微な欠点のみ。
- 3: 及第。無視できない欠点あり。
- 2: 不十分。重要な欠陥あり。
- 1: 不良。要件を大きく外している。
- 0: 無回答・的外れ・拒否。

評価軸:
${set.items[0]?.scoringRubric.dimensions
    .map((d) => `- **${d.labelJa}**（${d.id}）: ${d.description}`)
    .join("\n") ?? "- （項目なし）"}

## 欠陥の重大度

- **軽微（minor）**: 品質は下げるが実用性は保たれる。
- **重大（major）**: 要件を実質的に損なう。
- **ブロッキング（blocking）**: そのままでは採用不可の致命的欠陥。

**ブロッキングを1件でも記録した場合、採用可否は「採用不可（not_qualified）」と
整合させてください。**

## 確信度（評価確信度）

自分の判断への確信度を 0.0〜1.0 で記録します（0=自信なし, 1=確信）。

## 日本語以外の回答の扱い

回答が日本語以外で書かれている場合でも、**原文のまま**採点対象とします。
自動翻訳はしていません。参考訳が付いている場合は「参考訳（採点対象外）」であり、
採点の根拠にしてはいけません。

## 提出方法

各 \`items/<ID>.md\` を読み、対応する採点を **scoring-sheet.json** に記入するか、
\`HumanReviewRecord\` 形式のJSONで提出してください（JSONが正式な取り込み形式です）。
`;
}

function renderArtifacts(item: BlindReviewItem): string {
  if (!item.extractedArtifacts || item.extractedArtifacts.length === 0) return "";
  const blocks = item.extractedArtifacts
    .map((a) => `### ファイル: ${a.path}\n\n\`\`\`\n${a.content}\n\`\`\``)
    .join("\n\n");
  return `\n## 抽出された成果物\n\n${blocks}\n`;
}

function renderReferenceTranslation(item: BlindReviewItem): string {
  if (!item.referenceTranslation) return "";
  const meta = item.translationMetadata;
  const metaLine = meta
    ? `\n> 翻訳者種別: ${meta.translatorType} / 翻訳者: ${meta.translatorId} / 生成: ${meta.translatedAt}`
    : "";
  return `\n## 参考訳（採点対象外）\n\n> ⚠ 以下は参考用の翻訳であり、採点対象ではありません。原文が正式な採点対象です。${metaLine}\n\n${item.referenceTranslation}\n`;
}

/** Render one reviewer item form in Japanese. */
export function renderItemMarkdownJa(item: BlindReviewItem): string {
  const constraints =
    item.requiredConstraints && item.requiredConstraints.length > 0
      ? item.requiredConstraints.map((c) => `- ${c}`).join("\n")
      : "（特になし）";
  const langNote =
    item.responseLanguage && item.responseLanguage !== "ja"
      ? `\n> 注: この回答は日本語以外（推定: ${item.responseLanguage}）で書かれています。原文のまま採点してください。\n`
      : "";

  const scoringRows = item.scoringRubric.dimensions
    .map((d) => `| ${d.labelJa} |  |  |`)
    .join("\n");

  return `# 評価対象 ${item.blindId}

- ドメイン: ${item.domain}
- 難易度: ${item.difficulty}
- ベンチマーク: ${item.benchmarkId} (v${item.benchmarkVersion})

## 課題

${item.taskText}

${item.expectedOutputFormat ? `## 期待する出力形式\n\n${item.expectedOutputFormat}\n` : ""}
## 必須条件

${constraints}

## モデル回答
${langNote}
${item.responseText}
${renderArtifacts(item)}${renderReferenceTranslation(item)}
## 採点

| 評価軸 | 点数（0–5） | コメント |
|---|---:|---|
${scoringRows}

## 指摘事項

- コード:
- 重大度: （minor / major / blocking）
- カテゴリ:
- 根拠:
- コメント:

## 総合評価

- 総合点（0–5）:
- 採用可否: （qualified / not_qualified / inconclusive）
- 評価確信度（0–1）:
- 備考:
`;
}

/** Render a machine-readable scoring sheet skeleton (canonical import format). */
export function renderScoringSheet(set: BlindReviewSet): unknown {
  return {
    schemaVersion: set.schemaVersion,
    reviewSetId: set.reviewSetId,
    rubricVersion: set.items[0]?.scoringRubric.version ?? "",
    instructions:
      "各 blindId について HumanReviewRecord を記入してください。scores は評価軸ID→0-5。",
    records: set.items.map((item) => ({
      schemaVersion: 1,
      reviewSetId: set.reviewSetId,
      blindId: item.blindId,
      reviewerId: "",
      rubricVersion: item.scoringRubric.version,
      scores: Object.fromEntries(item.scoringRubric.dimensions.map((d) => [d.id, null])),
      findings: [],
      overallScore: null,
      qualificationRecommendation: "",
      confidence: null,
      notes: "",
    })),
  };
}

/** Render a pairwise comparison form in Japanese. */
export function renderPairwiseItemMarkdownJa(item: PairwiseItem): string {
  return `# 比較評価 ${item.blindId}

- ドメイン: ${item.domain}
- ベンチマーク: ${item.benchmarkId} (v${item.benchmarkVersion})

## 課題

${item.taskText}

${item.expectedOutputFormat ? `## 期待する出力形式\n\n${item.expectedOutputFormat}\n` : ""}
## 回答 A

${item.responseA}

## 回答 B

${item.responseB}

## 判定

- 選択: （a_clearly_better / a_slightly_better / equivalent / b_slightly_better / b_clearly_better）
- 評価確信度（0–1）:
- 理由（任意）:
`;
}

export function renderPairwiseGuideJa(set: PairwiseReviewSet): string {
  return `# 対比較（ペアワイズ）レビューガイド

**${set.reviewSetId}** の対比較評価です。各項目で回答 A と B を比較し、どちらが
優れているかを選びます。**A と B のどちらがどのモデルかは秘匿されており**、
提示順（A/B）も無作為化されています。文体の好みではなく、要件充足と正確性で
判断してください。外部の自動評価結果は参照しないでください。
`;
}
