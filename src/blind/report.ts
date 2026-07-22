/**
 * Japanese analysis report. Before unblinding, only blind ids appear; per-target
 * (model-level) results are added only when the analysis was unblinded.
 */
import { NumberStats } from "../experiment/stats.js";
import { AnalysisResult } from "./analysis.js";

function n(v: number | null, digits = 2): string {
  return v === null ? "—" : v.toFixed(digits);
}
function stats(s: NumberStats): string {
  return `平均 ${n(s.mean)} / 中央 ${n(s.median)} / 標準偏差 ${n(s.stddev)} / 最小 ${n(s.min)} / 最大 ${n(s.max)}`;
}

export function renderAnalysisReportJa(result: AnalysisResult): string {
  const lines: string[] = [
    `# 人手レビュー分析レポート: ${result.reviewSetId}`,
    "",
    result.unblinded
      ? "> ⚠ このレポートは **アンブラインド済み**（モデル identity を結合済み）です。"
      : "> このレポートは **ブラインド状態**です。表示は blind ID のみで、モデル identity は含みません。",
    "",
    "## 概要",
    "",
    `- 対象項目数: ${result.counts.items}`,
    `- 総レビュー数: ${result.counts.reviews}`,
    `- レビュアー数: ${result.counts.reviewers}`,
    `- レビュー済み項目: ${result.counts.reviewedItems}`,
    `- 未レビュー項目: ${result.counts.missingItems}`,
    "",
    "## 評価軸別スコア分布",
    "",
    "| 評価軸 | 統計 |",
    "| --- | --- |",
    ...Object.entries(result.byDimension).map(([dim, s]) => `| ${dim} | ${stats(s)} |`),
    `| （総合点） | ${stats(result.overall)} |`,
    "",
    "## レビュアー間一致",
    "",
    `- 比較可能項目（2名以上）: ${result.interReviewer.comparableItems}`,
    `- 採用可否の一致率: ${n(result.interReviewer.qualificationAgreementRate)}`,
    `- 総合点の平均絶対差: ${n(result.interReviewer.overallScoreMae)}`,
    "",
    "## レビュアー自己整合性",
    "",
    `- 反復レビュー対: ${result.selfConsistency.repeatedPairs}`,
    `- 総合点の平均標準偏差: ${n(result.selfConsistency.meanOverallStddev)}`,
    "",
    "## 不一致の例（総合点の乖離が大きい項目）",
    "",
  ];

  if (result.disagreementExamples.length === 0) {
    lines.push("（該当なし）");
  } else {
    lines.push("| blind ID | 総合点の幅 | 採用可否 |", "| --- | ---: | --- |");
    for (const ex of result.disagreementExamples) {
      lines.push(`| ${ex.blindId} | ${ex.overallSpread} | ${ex.recommendations.join(", ")} |`);
    }
  }

  if (!result.unblinded) {
    lines.push(
      "",
      "---",
      "",
      "モデル別の結果・評価器との比較は、明示的なアンブラインド後にのみ生成されます",
      "（`plinius human-review unblind` / `report --unblind`）。",
      "",
    );
    return lines.join("\n") + "\n";
  }

  // Unblinded sections.
  lines.push("", "## モデル別結果（アンブラインド後）", "", "| ターゲット | 総合点 | 採用可率 |", "| --- | --- | ---: |");
  for (const [target, v] of Object.entries(result.byTarget ?? {})) {
    lines.push(`| ${target} | ${stats(v.overall)} | ${n(v.qualifiedRate)} |`);
  }

  if (result.vsDeterministic) {
    const d = result.vsDeterministic;
    lines.push(
      "",
      "## 決定的評価との比較",
      "",
      `- 比較件数: ${d.compared}`,
      `- 一致率: ${n(d.agreementRate)}`,
      `- 誤合格率（人間=合格だが決定的にブロッキング失敗）: ${n(d.falseQualificationRate)}`,
      `- 誤棄却率（人間=不合格だが決定的に全通過）: ${n(d.falseRejectionRate)}`,
      `- 致命的欠陥見逃し率: ${n(d.catastrophicMissRate)}`,
    );
  }

  if (result.vsJudge) {
    const j = result.vsJudge;
    lines.push(
      "",
      "## LLM審査との比較",
      "",
      `- 比較件数: ${j.compared}`,
      `- 総合点の平均絶対誤差（0–1正規化）: ${n(j.overallMae)}`,
      `- 順位相関（Spearman）: ${n(j.rankCorrelation)}`,
    );
  }

  if (result.pairwiseWinRateByTarget) {
    lines.push("", "## 対比較の勝率（アンブラインド後）", "", "| ターゲット | 勝ち | 比較数 | 勝率 |", "| --- | ---: | ---: | ---: |");
    for (const [target, v] of Object.entries(result.pairwiseWinRateByTarget)) {
      lines.push(`| ${target} | ${v.wins} | ${v.comparisons} | ${n(v.winRate)} |`);
    }
  }

  lines.push(
    "",
    "## 推奨事項",
    "",
    "- 一致率の低い評価軸はルーブリックの定義見直しを検討してください。",
    "- 人間と決定的評価が食い違う項目は、ベンチマークのチェック設計を再確認してください。",
    "- 本レビューセットが calibration 用途の場合、モデルの正式合否には使用しないでください。",
    "",
  );
  return lines.join("\n") + "\n";
}
