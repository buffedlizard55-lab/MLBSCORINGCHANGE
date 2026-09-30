# analysis/ — the 2026-09-30 error→hit model study

Everything here is a **derived, regenerable study artifact** — none of it is an input to the
published model or the site. The findings and method are written up in
[docs/model-improvement-2026.md](../docs/model-improvement-2026.md).

| file | what it is |
| --- | --- |
| `model-rows.json.gz` | one row per error→hit population play (2024–2026): label, final ruling, status, out-of-fold model p, log-implied original error type, Error Watch join (hitProb, error kind + source, scorer), official scorer, and the full compact play record (Statcast hitData, runners, outs, score, bat side). Written by `tools/dump-model-rows.mjs` on GitHub Actions (MLB hosts are reachable only there); provenance and fetch counts in `model-rows.meta.json`. |
| `study.mjs` | the whole study in one run (`--only=a,b,c,d,e,f` to pick sections): baseline diagnosis, change rates by every candidate feature, the error-type leakage trap, batter/scorer permutation tests, the candidate feature sets through the exact production protocol, and the production-ladder selection with its effect on the scores of changed plays. Needs no network. |
Refresh the dump after a season rollover (or any time fresh labels matter):

```bash
gh workflow run model-rows-dump.yml --ref <branch>
```

The workflow reuses the pipeline's play-by-play Actions cache, so a warm re-dump takes seconds.
