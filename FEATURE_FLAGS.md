# 2026-05-13

Feature flag inventory from the unpacked production bundle at
`/tmp/codex-app-asar/webview/assets`.

The app bundle strips Statsig names down to numeric identifiers. Feature-area
labels below are inferred from bundle callsites and filenames. Confirmed gates
come from Statsig `useGateValue` / `checkGate` wrappers.

## Statsig Gates

| ID | Inferred area |
| --- | --- |
| `505458` | composer / hotkey home |
| `410065390` | in-app browser availability |
| `410262010` | in-app browser availability |
| `459748632` | workspace file command menu / browser |
| `489124297` | composer browser-ish action |
| `533078438` | remote connections |
| `588076040` | plugins page |
| `614250066` | app main / model-ish |
| `839469903` | artifact tab |
| `875176429` | personalization / composer |
| `896050304` | pull request board |
| `900122030` | login route |
| `1025755912` | dictation / diff comments |
| `1042620455` | remote connection visibility |
| `1063250567` | prompt/plugin link render |
| `1115442235` | composer / remote-ish |
| `1221508807` | background subagents |
| `1244621283` | diff comments / keyboard shortcuts / settings |
| `1258561229` | composer |
| `1269116100` | plugins |
| `1372061905` | settings / keyboard shortcuts |
| `1378180112` | composer |
| `1420162012` | review file source tab |
| `1444479692` | personality / personalization |
| `1488233300` | automations / heartbeat / local thread |
| `1506311413` | in-app browser availability |
| `1767204071` | composer / model-ish |
| `1786686482` | GPU tearing debug |
| `1823130936` | composer / model-ish |
| `1907601843` | composer / model-ish |
| `1981165915` | settings / git-ish |
| `2106641128` | agent settings |
| `2171042036` | app main / browser-ish |
| `2212532336` | app main |
| `2302560359` | navigate to local conversation |
| `2337831332` | app main |
| `2380644311` | realtime thread / debug modal |
| `2413345355` | local conversation thread |
| `2423536643` | general settings / app main |
| `2425897452` | NUX / general settings / app main |
| `2553306736` | git settings |
| `2574306096` | chronicle setup |
| `2761268526` | app connect / plugin availability |
| `2764989143` | git settings / composer |
| `2798711298` | NUX |
| `2846336681` | permissions mode |
| `2882842607` | composer / git-ish |
| `2929582856` | app main / browser-ish |
| `3074100722` | `/goal` command availability |
| `3075919032` | remote connections |
| `3326157269` | automations/background tasks |
| `3487373434` | local conversation thread |
| `3736891373` | permissions mode |
| `3789238711` | remote connections |
| `3853306575` | local conversation / automations |
| `3903563814` | app main / browser-ish |
| `4100906017` | diff comments / settings / shortcuts |
| `4114442250` | remote connection visibility |
| `4132970629` | app main / browser-ish |
| `4166894088` | local conversation / model-ish |
| `4261455886` | app-server tail hydration |
| `4285490330` | diff comment sources |

## Other Statsig Values

These are Statsig dynamic configs/layers/experiments, not boolean gates.

| ID | Kind |
| --- | --- |
| `72216192` | layer |
| `107580212` | dynamic config |
| `1193530394` | dynamic config |
| `2096615506` | layer |
| `2523619087` | layer |
| `3810344883` | dynamic config |
