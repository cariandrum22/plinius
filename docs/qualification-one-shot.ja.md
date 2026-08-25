# Qualification one-shot実行契約

## 目的

本契約は`plinius-qualification-2026-08-22-v1`のhistorical sentinel 1件を再実行せず，残る23 cellsをUbuntu実行ホストで一度だけ実行するためのものである．汎用resume system又は耐改竄journalの構築を目的としない．

Mac authority hostはsource，fixture，campaign order及びEvidence構造を検証する．FableはUbuntu実行ホストのruntime事実，host lifecycle及び実行を監督する．MacでUbuntuのOCI状態を推測しない．

## Production mode

production continuation modeは`diagnostic-one-shot-r1`だけである．旧`diagnostic-continuation-r1`及び`CONTINUATION_RESUME`はfail-closeで拒否する．

- output rootは開始時に空でなければならない．
- historical run，frozen campaign及びparent bundleのraw digestを変更しない．
- continuation orderはfrozen 24-cell orderのindex 1から23までである．
- 各cellは最大1 attemptである．retry，fallback，substitution及び自動resumeを行わない．
- dispatch前にdurable intentを作成し，provider call直前に`dispatch_started`をdurableに記録する．
- request開始後にprocessが中断したcellはoutcome uncertainであり，再dispatchしない．partial Evidenceを封緘してauthorityへ戻す．
- OpenAI sentinelがacceptedでなければ残る22 cellsを開始しない．non-sentinel failureは記録し，次のcellへ進む．

## Ubuntu execution attestation

driverはDocker inspect，snapshot walk又はlocal runtime推測を行わない．FableがUbuntu上で作成したstrict schemaのexecution attestationを`FABLE_EXECUTION_ATTESTATION_PATH`から読み，parent Evidenceから導出したexpected runtimeと照合する．

attestationは次を満たさなければならない．

- schema version，campaign ID及びsupervisor identityが固定値と一致する．
- capture時刻はparse可能で未来ではなく，driver評価時点から5分以内である．
- hostは`p4d.24xlarge`，GPU modelはA100，GPU countは8である．
- local targetはQwen及びgpt-ossのexact 2件で，duplicate，missing及びextraがない．
- endpoint，served model，checkpoint revision，weight-manifest digest，OCI image digest及びeffective argvがparent Evidenceとexact一致する．
- OCI processはUbuntuで観測した`Path`と`Args`を別々のtoken arrayとして保存する．`engineArgvSource`で`Path＋Args`又は`Args only`のどちらがparentの`serving.engineArgs`に対応するかを明示し，driverが再構成した`engineArgv`とparent値をexact照合する．`Config.Cmd`，`Config.Entrypoint`等のexpected metadataをobserved値へ転記しない．
- 各targetのcampaign外canaryはresponse model exact，non-empty output，finish reason accepted及びpassである．
- attestationにはcredential，authorization header，cookie，provider response本文又はprivate mappingを含めない．

attestation fileはabsolute pathで指定し，実行uid所有のregular non-symlink，mode`0400`又は`0600`，1 MiB以下とする．driverは`O_NOFOLLOW`でfile descriptorを開き，読取り前後のdevice，inode，size，mtime及びctime不変を検査する．既知の実行hostはinstance ID`i-020008472625521bd`，availability zone`us-west-2b`，instance type`p4d.24xlarge`，GPU`NVIDIA A100-SXM4-40GB`×8である．local canary requestはsourceで定義したcanonical body及びSHA-256に固定し，過去のgpt-oss 64-token canaryが`length`になったため`max_tokens=1024`とする．

attestation不一致時はOpenRouter credentialを読まず，catalog，provider API及びgenerationを0のまま停止する．

## 固定local期待値

両targetのOCI image digestは`sha256:0a51ea5b4ae2dc5d81890e5173f54203d2a3ae0cfffe51b8fd2afd4391bfd967`である．その他の期待値は次のとおりである．

Qwen：

- slug／served model：`Qwen/Qwen3.8-27B`
- endpoint：`http://localhost:8001/v1`
- checkpoint：`1d4bf0f2ff6012fd82039f2fa52739d0dd7c60c0`
- weight manifest：`sha256:d67d740e1ce3a0eda51cadf908c3d9f42248ccf0648d7c91448b81a00d943eda`
- engine argv：`serve --model Qwen/Qwen3.8-27B --revision 1d4bf0f2ff6012fd82039f2fa52739d0dd7c60c0 --served-model-name Qwen/Qwen3.8-27B --tensor-parallel-size 2 --dtype bfloat16 --max-model-len 49152 --gpu-memory-utilization 0.90 --seed 1`
- canary request SHA-256：`sha256:062446ab5bee921c528bb1d1448435d495349e53d72cbd120bb32ab90d75bc64`

gpt-oss：

- slug／served model：`openai/gpt-oss-20b`
- endpoint：`http://localhost:8002/v1`
- checkpoint：`6cee5e81ee83917806bbde320786a8fb61efebee`
- weight manifest：`sha256:2e68a02214cd6eec14b8135f954e8a8d010d330f32bdbede4fd7b02b241647b9`
- engine argv：`serve --model openai/gpt-oss-20b --revision 6cee5e81ee83917806bbde320786a8fb61efebee --served-model-name openai/gpt-oss-20b --tensor-parallel-size 1 --max-model-len 49152 --gpu-memory-utilization 0.90 --seed 1`
- canary request SHA-256：`sha256:f3457bf9e72c120878a390cd13691aab954087b000666e719b6fe087344b32c0`

上記値はattestationから採用せず，固定digestで検証したparent Evidenceの4 local-authority artifactsからMacとUbuntuの双方で再導出する．

## Attestation shape

normative schemaは`src/qualification/execution-attestation.ts`である．Fableは次のfield shapeで1 fileを作る．`targets`には上記2件だけを入れ，`capturedAtUtc`は両canary完了後に採時する．

```json
{
  "schemaVersion": 1,
  "campaignId": "plinius-qualification-2026-08-22-v1",
  "stageId": "plinius-qualification-2026-08-22-diagnostic-one-shot-r1",
  "supervisor": "Fable",
  "observationSource": "live-ubuntu",
  "capturedAtUtc": "<ISO-8601 UTC>",
  "host": {
    "instanceId": "i-020008472625521bd",
    "instanceType": "p4d.24xlarge",
    "availabilityZone": "us-west-2b",
    "operatingSystem": "Ubuntu",
    "gpuModel": "NVIDIA A100-SXM4-40GB",
    "gpuCount": 8
  },
  "targets": [
    {
      "requestedSlug": "<exact slug>",
      "endpoint": "<exact endpoint>",
      "servedModelId": "<observed exact model>",
      "checkpointRevision": "<40-hex revision>",
      "weightManifestSha256": "sha256:<64-hex>",
      "ociImageDigest": "sha256:<64-hex>",
      "ociProcess": {
        "path": "<observed OCI Path>",
        "args": ["<observed OCI Args tokens>"],
        "engineArgvSource": "args-only",
        "engineArgv": ["<driver-reconstructable engine tokens>"]
      },
      "canary": {
        "campaignExternal": true,
        "requestSha256": "sha256:<fixed 64-hex>",
        "responseSha256": "sha256:<observed 64-hex>",
        "responseBytes": 1,
        "responseModelId": "<observed exact model>",
        "finishReason": "stop",
        "outputNonEmpty": true,
        "passed": true,
        "completedAtUtc": "<ISO-8601 UTC>"
      }
    }
  ]
}
```

`engineArgvSource`は観測された`Path＋Args`全体がengine argvなら`path-plus-args`，観測された`Args`がengine argvなら`args-only`とする．都合のよい方を選ぶのではなく，OCIの実process構造に従う．unknown fieldは許可しない．

## Evidence

各dispatchはrequest／response／cost lookupのbyte-preserving wire evidence，digest，usage，routing，finish reason，normalized output及びclassificationを保存する．responseを受けたoutcomeとtransport failureを混同しない．

one-shot実行はresume判定を行わない．正常完了時はsummary及びartifact indexを作る．process中断時はFableが既存directoryを変更せずpartial Evidenceとして封緘する．後続processが既存recordをskip又は再dispatchして完走させてはならない．

## Host lifecycle

Mac authority reviewが完了するまでA100 hostを起動しない．Ubuntu再起動後はattestation，local canary，hosted catalog，23-cell execution，Evidence転送及びcompute stopを同じbounded windowで行う．attestation又はpreflight failure時はcampaignを開始しない．strict schemaに入らないattestation本文はdriver Evidenceへ複製せず，Fableがsecretを含まないmetadata-only rejection reportとprocess logを封緘する．catalog以後のpreflight failureはdriverが作成したpartial Evidenceをそのまま封緘する．

## Definition of Done

- r7 freeze branchを変更していない．
- one-shot branchのsource review，typecheck，build，offline tests及びauthority fixturesがMacで完了している．
- production modeからresume及びdriver内OCI observerへ到達できない．
- valid／stale／wrong-host／wrong-runtime／failed-canary attestation fixtureが独立testで固定されている．
- Ubuntu固有の確認事項はFable attestationとして明示され，Mac testのmock passをlive observationとして扱わない．
- Stage C2開始にはMac authorityの明示的GOが別途必要である．
