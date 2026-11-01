# PERF — `renderer.info` (budżet SPEC §7)

Pomiar: Chromium headless (SwiftShader), 1280×720, dpr 1, `renderer.info.autoReset=false` → wartości obejmują całą klatkę (scena + passy postprocessu).
FPS w headless nie jest miarodajny — oceniany ręcznie.

## M0 — UV Maze, sama arena (commit z grafiką M0)

| Preset | calls | triangles | textures | geometries | programs | budżet calls / tris / tex / geom |
|---|---|---|---|---|---|---|
| low | 10 | 17.7k | 10 | 10 | 6–7 | 60 / 120k / 20 / 80 |
| medium | 25 | 17.7k | 22 | 11 | 16 | 90 / 200k / 28 / 80 |
| high | 31 | 24.4k | 23 | 12 | 20 | 120 / 350k / 36 / 90 |
| ultra | 31 | 24.5k | 23 | 12 | 20 | 160 / 600k / 44 / 100 |

Wycieki: 2 cykle low→ultra i 2× `setWorld` → `renderer.info.memory` bez zmian.

## M1 — UV Maze + gracz + 3 manekiny (wiązki, iskry, awatary, view model)

| Preset | calls | triangles | textures | geometries | programs |
|---|---|---|---|---|---|
| medium | 30 | 31.2k | 22 | 16 | 21 |
| high | 36 | 37.8k | 23 | 17 | 25 |

Elementy M1: +5 draw calli (wiązki 1, iskry 1, korpusy awatarów 1, sensory 1, broń FPP 1).

## CPU / alokacje (Node, `--expose-gc`, `v8.GCProfiler`)

| Funkcja (100k wywołań) | GC w oknie | B / wywołanie |
|---|---|---|
| moveBody (stoi / chodzi) | 0 / 0 | 0.09 |
| stepMovement | 0 | 0.09 |
| raycastWorld | 0 | 0.08 |
| segmentClear | 0 | 0.12 |
| stepSim (4 uczestników, ciągły ogień) | — | przyrost sterty po gc 47.8 KB / 100k kroków (przed poprawką fizyki) |

## M0 iteracja 3 + M2/M3/M4 (smoke, 8 uczestników, wszystkie mapy)

Smoke (tester, przed iteracją 3 grafiki) — calls / triangles / textures / geometries:

| Mapa | low | medium | high | ultra |
|---|---|---|---|---|
| uvmaze | 16 / 53k / 11 / 16 | 31 / 56k / 23 / 17 | 43 / 111k / 25 / 17 | 43 / 111k / 25 / 17 |
| neonhive | 16 / 64k / 11 / 16 | 31 / 67k / 23 / 17 | 43 / 134k / 25 / 17 | 43 / 134k / 25 / 17 |
| reactor | 16 / 48k / 11 / 16 | 31 / 49k / 23 / 17 | 43 / 98k / 25 / 17 | 43 / 98k / 25 / 17 |

Po iteracji 3 + render M4 (Ultra, gra, `npm run screens`): uvmaze 39 / 61.5k / 25 / 17, neonhive 39 / 85.4k / 25 / 17, reactor 49 / 54.5k / 26 / 22
(rdzeń reaktora +4 calle; awatar 2.1k → 1.5k tris).

Wycieki: 6 zmian map (menu → mecz) i 2 cykle presetów → textures/geometries wracają do wartości startowych.
Symulacja: 8 botów 8–11 µs/krok; `stepSim` z 8 botami na 3 mapach: 0 GC / 100k kroków (noalloc.test.mjs).

## Finał (2026-10-31, smoke po ostatniej rundzie grafiki, 8 uczestników, viewport 640×360 — liczby nie zależą od rozdzielczości)

| Mapa | low | medium | high | ultra | budżet ultra |
|---|---|---|---|---|---|
| uvmaze | 16 / 42.5k / 11 / 16 | 32 / 42.6k / 23 / 17 | 43 / 69.3k / 26 / 18 | 43 / 69.4k / 26 / 18 | 160 / 600k / 44 / 100 |
| neonhive | 17 / 60.3k / 12 / 17 | 33 / 60.4k / 24 / 18 | 45 / 97.4k / 27 / 19 | 45 / 97.5k / 27 / 19 | |
| reactor | 23 / 42.5k / 13 / 23 | 39 / 42.5k / 25 / 24 | 57 / 70.5k / 28 / 25 | 57 / 70.6k / 28 / 25 | |

(calls / triangles / textures / geometries.) Najbliżej limitu: Medium — tekstury 25/28 na Reactor (RT bloom/odbicia/env + farba).
High/Ultra: +1 pełnoekranowy pass NaN-guard przed bloomem; odbicie planarne ≈ +12 calli i ~+40% trójkątów (największy koszt GPU).
Programy shaderów: 12–36 (Reactor ultra 36).
Wycieki: po powrocie na mapę geometrie/tekstury = wartości startowe (g16→16, t11→11).

## Postać + broń FPP (D-024, uvmaze, 8 uczestników)

| Preset | przed (calls / tris) | po (calls / tris) | budżet |
|---|---|---|---|
| high | 43 / 69.5k | 45 / 91.9k | 120 / 350k |
| low | 16 / 42.7k | 18 / 56.2k | 60 / 120k |

Awatar 2492 tris, broń + ręce 2144 tris. `avatars.sync` i `viewModel.update`: 0 GC / 100k klatek.
