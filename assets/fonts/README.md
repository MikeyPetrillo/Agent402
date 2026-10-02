# Fonts

Four families, all under the SIL Open Font License 1.1. The full licence text for each is in
`licenses/`, because OFL 1.1 condition 2 requires the copyright notice and licence to be
distributed with the font files. These are subsetted woff2 builds whose internal name tables are
stripped, so the licence does not travel inside the binaries and has to travel beside them.

| Family | Files | Copyright | Upstream |
|---|---|---|---|
| Geist | `geist-*.woff2` | Copyright 2024 The Geist Project Authors | https://github.com/vercel/geist-font |
| Geist Mono | `geist-mono-*.woff2` | Copyright 2024 The Geist Project Authors | https://github.com/vercel/geist-font |
| Archivo | `archivo-*.woff2` | Copyright 2020 The Archivo Project Authors | https://github.com/Omnibus-Type/Archivo |
| Space Mono | `spacemono-*.woff2` | Copyright 2016 The Space Mono Project Authors | https://github.com/googlefonts/spacemono |

Subsetting makes these Modified Versions under the OFL. None is distributed under a Reserved Font
Name, and none of the upstream projects declares one.

Adding a font means adding its licence here too: `scripts/test-font-licenses.js` fails the build
otherwise.
