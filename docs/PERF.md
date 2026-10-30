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
