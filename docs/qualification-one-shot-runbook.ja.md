# Qualification one-shot実行runbook

## 状態

本書はUbuntu実行host向けの準備手順であり，Stage C2の実行許可ではない．Mac authorityがone-shot branchのsigned commitを受領し，明示的GOを出すまでA100 hostを起動しない．r7 freeze commit `1e193d0b7268e6a405baa82d53b853af5997f001`及び既存Evidenceは変更しない．

## Mac側GO条件

- one-shot commitのparentがr7 freeze commitであり，署名，tree及びchanged-path allowlistを検証済みである．
- typecheck，build，one-shot fixture，targeted suite及び既知のmacOS TLC環境差を除くfull suiteが検証済みである．
- 実行commit hash，parent Evidence bundle digest，parent root及び出力先が固定されている．
- `OPENROUTER_API_KEY`を含むcredentialはMac package又はattestationへ入っていない．

## Bounded compute window

1. Fableがinstance `i-020008472625521bd`を起動し，`p4d.24xlarge`，`us-west-2b`，Ubuntu，`NVIDIA A100-SXM4-40GB`×8をcontrol planeとhost内の双方で確認する．
2. 実行repositoryを指定されたsigned commitへdetached checkoutし，commit署名，parent，tree，source digests，clean worktree及び0 stashを確認する．branch tipの移動を実行根拠にしない．
3. credentialを未注入のまま，parent bundle／frozen campaign／historical run／4 local-authority artifactsの固定digestを確認する．1件でも不一致ならhosted catalogへ接続せず停止する．
4. deepwikiの一時停止はauthorityが許可済みである．ただしbare processをkillしてはならない．`scripts/qualification-local-runtime.sh preflight`でport 8001を所有するdeepwikiが復旧可能なDocker containerであること，GPU 1／2／3が空いていること，pinned imageとsnapshotがlocalに存在することを確認する．`PLINIUS_RUNTIME_STATE`を新規absolute path，`PLINIUS_DEEPWIKI_CONTAINER`を観測したcontainer name又はIDとして`deploy`を1回実行する．scriptはdeepwikiを停止し，QwenをGPU 1／2とport 8001，gpt-ossをGPU 3とport 8002へ配置する．image pull，model download，GPU 0への割当及び自動restartは禁止されている．
5. 2 local targetについてlive OCI `Path`／`Args`，RepoDigest，served model，checkpoint revision及びlive snapshotのweight-manifest digestを観測する．expected metadataをobserved fieldへ転記しない．deployment scriptの成功をattestationの代用にしてはならない．
6. `localCanaryRequestBody(model)`とbyte-identicalなcampaign外canaryを各targetへ1回送り，request digest，response digest／bytes，exact response model，`stop`，non-empty output及び完了時刻を記録する．canary失敗時はcampaignを開始しない．
7. normative schemaに従うattestationを新規fileへ書き，mode `0600`，実行uid所有，absolute pathとする．`capturedAtUtc`は全観測と両canaryの完了後に採時する．
8. secret injection mechanismでcredentialをprocess environmentへ渡し，次のproduction modeを1回だけ起動する．literal keyをshell history，log又はEvidenceへ出さない．

```sh
env -u CONTINUATION_RESUME -u PLINIUS_LOCAL_BINDING_DIR \
  PLINIUS_DRIVER_MODE=diagnostic-one-shot-r1 \
  CONTINUATION_OUTPUT_ROOT="$FRESH_OUTPUT_ROOT" \
  PARENT_EVIDENCE_ROOT="$PARENT_EVIDENCE_ROOT" \
  PARENT_BUNDLE_PATH="$PARENT_BUNDLE_PATH" \
  FABLE_EXECUTION_ATTESTATION_PATH="$FABLE_EXECUTION_ATTESTATION_PATH" \
  OPENROUTER_API_KEY="$OPENROUTER_API_KEY" \
  ./node_modules/.bin/tsx qualification-driver.mts
```

9. process終了後は成功／失敗を問わず同じoutput rootでdriverを再起動しない．中断cellは`attempt_outcome_uncertain`として扱い，再dispatchしない．
10. output root，attestation，secret-free process log，`PLINIUS_RUNTIME_STATE`及びFable lifecycle metadataをread-only packageへ封緘し，SHA-256とsizeをMac authorityへ転送する．quarantine又はcredentialをpackageへ含めない．
11. 転送物のremote read-back digestが一致した後，同じstate pathで`scripts/qualification-local-runtime.sh teardown`を実行する．scriptが作成した2 containerだけが停止・削除され，記録済みの同一deepwiki containerがport 8001へ復旧したことを確認する．その後VRAM解放を確認してinstanceをstopする．自動restart mechanismがないことをcontrol planeで確認する．

deploymentの標準呼出しは次のとおりである．`pnpm install`は行わず，承認済みのshared `node_modules` symlinkを変更しない．

```sh
export PARENT_EVIDENCE_ROOT=/absolute/verified/parent/root
export PLINIUS_DEEPWIKI_CONTAINER=<live-observed-container-name-or-id>
export PLINIUS_RUNTIME_STATE=/absolute/fable-run-root/local-runtime-state.json
./scripts/qualification-local-runtime.sh plan
./scripts/qualification-local-runtime.sh preflight
./scripts/qualification-local-runtime.sh deploy
```

## 即時停止条件

- source／authority digest mismatch
- dirty worktree，unexpected commit又は署名不一致
- host／GPU mismatch
- attestation schema，freshness，ownership又はmode failure
- local targetのmissing／extra／duplicate
- endpoint，model，checkpoint，weight digest，image digest又はengine argv mismatch
- canary failure
- non-empty output root
- invocation lockの既存

上記停止後に値を修正して同じwindowで再実行してはならない．metadata-only failure reportを封緘し，Mac authorityの新しい判断を待つ．
