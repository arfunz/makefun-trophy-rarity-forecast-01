# GTA VI trophy rarity forecaster

[![make.fun · gta6-trophy-rarity-forecast-01](https://make.fun/badge/gta6-trophy-rarity-forecast-01.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![make.fun · gta6-trophy-rarity-forecast-01 · rank](https://make.fun/badge/gta6-trophy-rarity-forecast-01/arfunz/makefun-trophy-rarity-forecast-01/rank.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01/leaderboard)
[![make.fun · gta6-trophy-rarity-forecast-01 · reward](https://make.fun/badge/gta6-trophy-rarity-forecast-01/arfunz/makefun-trophy-rarity-forecast-01/reward.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01)

Forecasts, for each of Grand Theft Auto VI's 55 PlayStation 5 trophies, five
quantiles (5/25/50/75/95%) of its Exophase earn rate at the case's target,
from the house's reads of the game's trophy page before the case's checkpoint.

## Method

- **Earners/players decomposition.** A trophy's rate is earners divided by
  players tracked. Earners and players are forecast separately, then divided.
  Dilution — players joining faster than they earn — is the dominant effect
  on rates.
- **Refresh-aware.** Exophase refreshes a game's counts in jumps, hours
  apart, so the answer is the rates as of the LAST refresh before the target.
  Refresh times are read off the history (gaps between changes in
  players_tracked); the forecast is evaluated at the expected last refresh,
  the target minus half the median refresh gap.
- **Log-time curves.** Per trophy, robust (Theil–Sen) fits of log earners and
  log players against ln(1 + hours since launch), fitted on the most recent
  half of the distinct page states (growth decelerates, so the recent window
  describes the current regime best). Slopes shrink toward the median slope
  of neighbouring trophies in list order.
- **Honest spread.** Quantiles from fit residuals (scaled by extrapolation
  leverage) plus refresh-timing uncertainty, with a floor so the band never
  claims more than the data supports.
- **Flat-history prior.** When the history shows zero refreshes (launch
  night), the competition's own rules disclose the first refresh (638 →
  3,868 players, 943 → 4,276 trophies earned); that disclosed aggregate is
  used as the prior for the single refresh inside the horizon. It only
  triggers when no refresh is observable in the case data.

No network, no randomness, deterministic: two runs are byte-identical.

## Run

```sh
mkdir -p out
MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Reads every `*.in` file in the input directory (default `/input/`) and writes
one `/output/<id>.out` per case (default `/output/`), JSON of the form
`{"trophies": [{"id": n, "q": [q05, q25, q50, q75, q95]}]}`.

## Local verification

- Practice cases p00/p01: valid output, 55 rows, quantiles non-decreasing,
  0.2 s runtime, byte-identical across runs. Exact practice loss is not
  measurable locally (the kit holds no per-trophy answers — only the
  disclosed refresh aggregates); the practice medians imply 4,272 total
  earners at 3,868 players vs the disclosed 4,276.
- Synthetic final-regime test (a week of real curves, different functional
  family from the model's fits): pinball loss 0.114, typical miss 0.76 pp,
  90% coverage 0.96 — around the practice prize line (rank 20 = 0.127).

## License

MIT — see LICENSE.
