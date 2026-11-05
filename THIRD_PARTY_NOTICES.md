# Third-party notices

MASAR AI's original source code is licensed under the MIT License (see [LICENSE](LICENSE)). That license covers only
the code and assets written for this project. The third-party software and fonts below keep their own licenses and
copyright holders. They are installed from npm (not stored in this repository) and are bundled into the built web
client, so their notices apply to any distribution of `client/dist`.

## Code copied into this repository

### webgl-noise — 3D simplex noise (GLSL)

Used in `client/src/orb/noise.ts` (Living Orb shaders).

> Copyright (C) 2011 by Ashima Arts (Simplex noise)
> Copyright (C) 2011-2016 by Stefan Gustavson (Classic noise and others)
>
> Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
> documentation files (the "Software"), to deal in the Software without restriction, including without limitation the
> rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to
> permit persons to whom the Software is furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all copies or substantial portions of
> the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO
> THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF
> CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
> IN THE SOFTWARE.

Source: <https://github.com/ashima/webgl-noise> (MIT).

## Fonts (SIL Open Font License 1.1)

Distributed through the Fontsource npm packages. The font files keep their OFL-1.1 license and their authors'
copyright; they may be bundled and redistributed with software but not sold on their own. See
<https://openfontlicense.org>.

| Font | Use | npm package |
|---|---|---|
| Aref Ruqaa Ink | Arabic wordmark مَسَارٌ (Arabic subset, weight 700) | `@fontsource/aref-ruqaa-ink` 5.3.0 |
| Tajawal | Arabic interface text | `@fontsource/tajawal` 5.3.0 |
| Inter (variable) | English interface text | `@fontsource-variable/inter` 5.3.0 |
| Space Grotesk (variable) | English display text and wordmark | `@fontsource-variable/space-grotesk` 5.3.0 |

## Runtime libraries bundled into the web client or used by the server

| Package | Version | License |
|---|---|---|
| react, react-dom | 19.3.1 | MIT |
| three | 0.187.0 | MIT |
| motion | 14.9.0 | MIT |
| @radix-ui/react-dialog | 1.3.1 | MIT |
| @radix-ui/react-dropdown-menu | 2.2.1 | MIT |
| lucide-react (icons) | 1.67.0 | ISC |
| zod | 4.6.7 | MIT |
| pg (node-postgres, server only) | 8.23.1 | MIT |

## Development tools (not distributed)

TypeScript (Apache-2.0), Vite (MIT), Tailwind CSS (MIT), @vitejs/plugin-react (MIT), Playwright (Apache-2.0),
PGlite and pglite-pgvector (Apache-2.0), and type packages (MIT). Their licenses are included in their npm packages.

## Test fixture content

`tests/fixtures/tavily-turkey-2026-11-03.json` stores a small set of public search results (titles, URLs and short
snippets from third-party travel websites, as returned by the Tavily API on 2026-11-03). It is kept only so tests can
replay real-world extraction without network calls. It is not used as content of the product, and the listed
offers belong to their respective websites.

## Original assets

The MASAR symbol, wordmark lock-ups, favicon, Living Orb shaders (apart from the noise function above), Living
Background, interface design and screenshots in `docs/assets/` were created for this project and are covered by the
project license. The four demo travel programs (Hurghada, Nubia, Sharm El Sheikh, Fayoum) and their prices are
fictional demonstration data.
