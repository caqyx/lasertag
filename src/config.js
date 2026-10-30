// CONFIG — jedyne źródło liczb w grze (SPEC §12). Moduły importują stąd, nie hardkodują wartości.
// Sekcje odpowiadają modułom. Wartości z SPEC §2/§5/§7.

export const CONFIG = Object.freeze({
  sim: {
    hz: 60,                 // stały krok symulacji
    maxSubSteps: 5,         // limit kroków na klatkę (ochrona przed spiralą śmierci)
  },

  player: {
    radius: 0.35,
    height: 1.8,
    eyeHeight: 1.65,
    walkSpeed: 3.8,         // D-015: tempo chodu w hali laser tag
    sprintSpeed: 5.6,
    crouchHeight: 1.15,     // wysokość ciała w kucu
    crouchEyeHeight: 1.0,   // oko w kucu
    crouchTime: 0.15,       // s — pełne przejście stanie ↔ kuc
    crouchSpeedMul: 0.45,   // mnożnik prędkości w pełnym kucu (bez sprintu i skoku)
    accelGround: 60,
    accelAir: 12,
    friction: 12,
    jumpSpeed: 5.0,
    gravity: 20,
    stepHeight: 0.45,       // max wysokość stopnia pokonywana bez skoku
    maxSlopeY: 0.6,         // nachylenie rampy: tan(kąta) maks. ~31°
    mouseSensitivity: 0.0022,
    pitchLimit: 1.45,       // rad
    fov: 78,
  },

  physics: {
    skin: 0.001,
    maxIterations: 4,       // iteracje rozwiązywania kolizji na krok
    groundSnap: 0.12,
  },

  weapon: {
    range: 50,
    fireInterval: 0.22,
    heatPerShot: 0.11,
    coolRate: 0.45,
    coolDelay: 0.25,
    overheatCoolRate: 0.6,
    overheatRecover: 0.35,
    beamDuration: 0.12,
    muzzleOffset: [0.22, -0.18, -0.45], // względem kamery (prawo, dół, przód)
  },

  combat: {
    maxHp: 4,
    damage: 1,
    eliminatedTime: 3.0,
    protectionTime: 2.0,
    hitFlashTime: 0.15,
    friendlyFire: false,
    hitCapsuleRadius: 0.42,
    hitCapsuleBottom: 0.2,
    hitCapsuleTop: 1.85,
    // sensory kamizelki: offset od stóp (x prawo, y, z przód); kolejność gaśnięcia: tył, lewe, prawe, przód
    sensors: {
      front: [0, 1.35, 0.22],
      back: [0, 1.35, -0.22],
      left: [-0.28, 1.55, 0],
      right: [0.28, 1.55, 0],
    },
    loseOrder: ['back', 'left', 'right', 'front'],
    spawnOccupiedRadius: 1.5, // m — spawn z żywym uczestnikiem bliżej niż to jest zajęty (pickSpawn)
    spawnOffset: 1.2,       // m — przesunięcie od spawnu, gdy wszystkie dozwolone zajęte
    hitStun: 0.45,          // D-016: s bez broni po trafieniu (nie eliminującym) — kto trafi pierwszy, wygrywa wymianę
    eventCapacity: 256,     // pierścień zdarzeń symulacji (core/events.js); czyszczony raz na klatkę renderu
    maxParticipants: 16,    // pojemność instancji awatarów
    dummy: {                // manekin treningowy (game/input/dummyInput.js — tylko testy)
      strafePeriod: 2.0,    // s — pełny cykl lewo → prawo
      strafeMove: 0.4,      // moveX (× walkSpeed) podczas chodzenia
    },
  },

  scoring: {
    hit: 10,
    elimination: 50,
  },

  modes: {
    ffa: { teams: 0, participants: 8, timeLimit: 300, elimLimit: 25 },
    tdm2: { teams: 2, perTeam: 4, timeLimit: 300, elimLimit: 60 },
    tdm4: { teams: 4, perTeam: 2, timeLimit: 300, elimLimit: 30 },
  },

  // Kamera gracza (main.js): wygładzanie wysokości oka (kucanie) i death cam (SPEC §2.2).
  camera: {
    eyeSmoothing: 14,       // 1/s — wykładnicze dążenie wysokości oka do eyeHeightOf(body)
    deathHeight: 2.6,       // m nad stopami ciała
    deathRise: 1.1,         // s — czas uniesienia (ease-out)
    deathLookRate: 4,       // 1/s — obrót w stronę zabójcy
    ceilingClearance: 0.25, // m odstępu od sufitu / spodu bryły nad ciałem
  },

  // Mecz (game/match.js) i UI meczu (ui/matchBar.js, ui/scoreboard.js).
  match: {
    countdown: 3.0,         // s odliczania przed startem (uczestnicy zamrożeni)
    goTime: 0.8,            // s wyświetlania „START!" po odliczaniu
    timerWarn: 30,          // s do końca → timer ostrzegawczy
    scoreboardRefresh: 0.25, // s między odświeżeniami tablicy (Tab)
    playerColorFfa: 5,      // indeks CONFIG.colors.ffa dla gracza w FFA (cyjan, spójnie z HUD)
  },

  colors: {
    teams: ['#ff3355', '#2f8bff', '#3dff7a', '#ffd600'],
    ffa: ['#ff3355', '#2f8bff', '#3dff7a', '#ffd600', '#ff4dff', '#00f0ff', '#ff8a00', '#b0ff00'],
  },

  bots: {
    levels: {
      easy:   { reaction: 0.65, aimSigmaDeg: 5.5, turnDegPerSec: 160, viewDist: 28, fovDeg: 100, strafe: 0,   coverHp: 1, coverOnOverheat: false, heatLimit: 1.0,
                retreatFirstHit: false, holdChance: 0.15, holdTime: [2, 4], maxFireDist: 25, flankChance: 0.3, sprintChase: false },
      normal: { reaction: 0.40, aimSigmaDeg: 3.0, turnDegPerSec: 260, viewDist: 38, fovDeg: 120, strafe: 0.5, coverHp: 2, coverOnOverheat: false, heatLimit: 0.9,
                retreatFirstHit: true, holdChance: 0.4, holdTime: [3, 6], maxFireDist: 30, flankChance: 0.7, sprintChase: false },
      hard:   { reaction: 0.24, aimSigmaDeg: 1.6, turnDegPerSec: 400, viewDist: 48, fovDeg: 140, strafe: 0.8, coverHp: 2, coverOnOverheat: true, heatLimit: 0.8,
                retreatFirstHit: true, holdChance: 0.5, holdTime: [4, 8], maxFireDist: 35, flankChance: 0.9, sprintChase: true },
    },
    chaseTime: 4.0,
    burstShots: [2, 5],
    burstPause: [0.35, 0.9],
    thinkInterval: 0.1,     // s między decyzjami FSM (rozłożone między botów)
    arriveDist: 0.6,
    stuckTime: 1.2,
    // --- bots/ai.js (M2)
    stuckMinMove: 0.35,     // m postępu w oknie stuckTime, poniżej = utknięcie (skok + nowa ścieżka)
    pathCapacity: 256,      // maks. długość ścieżki (węzły)
    rampDy: 0.15,           // m — różnica wysokości węzłów oznaczająca odcinek rampy
    rampArriveDist: 0.3,    // m — dojście do waypointu na rampie (zamiast arriveDist), bez sprintu
    patrolSamples: 6,       // losowane kandydaty celu patrolu (preferencja nieodwiedzonych)
    patrolMinDist: 6,       // m — min. odległość celu patrolu
    aimHeight: 1.3,         // m nad stopami celu (klatka)
    fireTolDeg: 3.5,        // strzał, gdy celownik ≤ tyle od punktu celowania (z rozrzutem)
    reacquireTime: 0.6,     // s — utrata celu krótsza niż to nie resetuje czasu reakcji
    hitAwareTime: 1.0,      // s — po trafieniu bot „zna" napastnika (bez sprawdzania FOV)
    engageRange: [6, 18],   // m — preferowany dystans walki (bliżej → cofanie, dalej → podejście)
    engageRepath: 0.8,      // s — odświeżanie ścieżki do celu w walce
    strafeSwitch: [0.45, 1.2], // s — zmiana kierunku strafe
    coverHold: 2.0,         // s w osłonie (dłużej, jeśli przegrzany)
    coverCooldown: 5.0,     // s przerwy przed kolejnym szukaniem osłony
    coverRadius: 12,        // m — promień szukania węzła osłony
    coverChecks: 24,        // maks. testów linii wzroku przy szukaniu osłony
    // zasadzki (HOLD) — level.holdChance / holdTime [s]
    holdCooldown: 6,        // s po zasadzce, zanim bot znów jej szuka
    holdCandidates: 8,      // kandydaci (węzły nav.cover) na pozycję zasadzki
    holdViewSamples: 6,     // próbki widoku na kandydata (linia wzroku do losowych węzłów)
    holdView: [6, 25],      // m — zakres odległości widocznych węzłów liczonych jako „widok na przejście"
    holdRange: [4, 20],     // m — odległość pozycji zasadzki od bota
    holdSweep: 0.35,        // rad — amplituda rozglądania się w zasadzce
    halfCover: [0.9, 1.4],  // m — wysokość osłony połówkowej (kucanie za nią)
    halfCoverDist: 1.2,     // m — maks. odległość krawędzi osłony od węzła
    // słuch: strzały w promieniu → podejście (z flanki: level.flankChance)
    hearRadius: 15,
    hearMemory: 1.0,        // s — jak długo usłyszany strzał jest „świeży"
    investigateTime: 8,     // s — limit podchodzenia do źródła dźwięku
    flankOffset: 6,         // m — boczne przesunięcie węzła pośredniego flanki
    adapt: {
      evalInterval: 30,
      window: 60,
      maxOffset: 0.25,
      step: 0.05,
      decay: 0.025,
      highRatio: 1.5,
      lowRatio: 0.67,
    },
  },

  nav: {
    cell: 1.0,              // rozdzielczość próbkowania węzłów
    clearance: 0.45,        // min. odległość węzła od ściany
    maxClimb: 0.45,
    linkDiagonal: true,
  },

  render: {
    near: 0.05,
    far: 120,
    toneMapping: 'neutral', // 'neutral' | 'aces' (patrz graphics.js)
    toneMappingExposure: 0.95,
    fogDensity: 0.055,
    fogTint: 0.07,          // kolor mgły = lerp(palette.fog, palette.uv, fogTint)
    clearColor: '#05030a',
    msaaSamples: 4,
    hdrMax: 64,             // strażnik HDR przed bloomem: clamp jasności, NaN/Inf → 0
    bloomFactors: [1.0, 0.5, 0.2, 0.07, 0.02],  // wagi 5 mipów UnrealBloomPass (domyślnie 1/.8/.6/.4/.2)
    // Oświetlenie (render/graphics.js): ciemność dominuje — ambient/hemi bardzo słabe.
    lights: {
      hemiIntensity: 0.3,     // HemisphereLight w kolorze palette.ambient
      hemiGround: 0.35,       // ziemia = ambient × to
      defaultRange: 12,       // zasięg światła, gdy dane mapy go nie podają (graphics + smoke)
      pointScale: 0.65,       // intensywność PointLight = light.intensity × to (decay 2)
      rangeScale: 1.0,
      drop: 0.9,              // PointLight pod oprawą lampy (m) — niżej: mniejsza plama na stropie
    },
    // Tekstury proceduralne (render/textures.js)
    textures: {
      paintMeters: [6, 2.4],  // kafel farby UV = 6 × 2.4 m
      floorMeters: 2,         // kafel podłogi (linia siatki co 2 m)
      floorLine: 0.012,       // grubość linii siatki podłogi (m)
      smokeSize: 256,
      wallMeters: 2.44,       // kafel faktury ściany (2 płyty 1.22 m)
      paintWide: 2.5,         // szerokość kafla farby = S × to (S ≥ paintWideFrom), inaczej 2 × S
      paintWideFrom: 1024,
      accentShare: 0.08,      // udział akcentu wśród drobnych elementów farby
    },
    // Dekoracje (render/decor.js)
    decor: {
      steelColor: '#2c2c36',
      core: {
        coverScale: 1.21,           // promień wizualu = r × to (ośmiokąt pokrywa gwiazdę 2 kwadratów kolizji)
        columnRadius: 0.55,         // walec energii = R × to
        intensity: 1.1,
        plinth: 1.2,                // cokół stalowy (m)
        collar: 0.6,                // kołnierz pod sufitem (m)
        cageRings: [2.4, 4.4, 6.2],
        glowRings: [1.6, 3.0, 3.8, 5.2, 6.8],
        ringIntensity: 1.6,
        warnIntensity: 1.4,
        steelGlow: 0.015,
        glassOpacity: 0.12,
        collarIntensity: 1.1,
        pipes: 6,
        pipeRing: 0.7,              // promień okręgu rur = R × to
        pipeRadius: 0.12,
      },
    },
    // Arena (render/arenaBuilder.js)
    arena: {
      seedSalt: 0xa11ce,            // sól ziarna RNG areny (offsety farby, kolory per bryła)
      wallColor: '#090a18',         // prawie czarny granat (× faktura sklejki)
      wallRoughness: 0.85,
      paintIntensity: 0.75,         // emisja farby UV (maski × kolor bryły; HDR → bloom)
      accentPaintScale: 0.8,        // akcent (limonka) tylko w drobnych elementach farby
      boundaryPaintScale: 1.4,      // ściany obwodowe: kafel 8.4 × 3.36 m (duże murale, ostre z bliska)
      boundaryPaintIntensity: 0.6,  // farba na ścianach obwodowych przygaszona (nie dominuje kadru)
      wallUScale: [0.85, 1.2],      // losowa skala farby wzdłuż ściany per bryła (mniej powtórzeń)
      boundaryCycle: ['reactor'],   // mapy, w których ściany obwodowe dostają różne style farby per strona
      uvRemap: { reactor: 'secondary' },   // mapy bez fioletu w palecie: kolor 'uv' (listwy, lampy, stożki, sufit) → ten klucz
      coneTint: { neonhive: { key: 'primary', mix: 0.55 } }, // stożki światła podbarwione kolorem przewodnim mapy
      // poświata UV/neonu na licu ściany (× kolor listwy bryły × faktura): mocna przy listwie, gaśnie w dół
      wash: { top: 0.06, fall: 0.38, bottom: 0.035, base: 0.0, edge: 0.03, edgeWidth: 0.03 },
      capWash: 0.2,                 // poświata na wierzchu brył (× wash)
      trimSize: 0.05,
      trimGap: 0.006,               // odsunięcie listwy od ściany (bez z-fightingu)
      trimBottomLift: 0.05,
      trimIntensity: 1.1,           // vertexColors HDR (> 1 → bloom); rdzeń nasycony, nie biały
      trimLumRef: 0.35,             // listwy: intensywność × sqrt(ref / luminancja koloru), zakres lumNormRange
      lumNormRange: [0.55, 1.7],
      trimSaturation: 1.35,         // podbicie nasycenia listew/lamp (tone mapping wybiela jasne kolory)
      lampClearance: 0.7,           // oprawa lampy min. tyle od bryły sięgającej sufitu (filar)
      // filar: pionowe listwy na narożnikach (cieńsze) + obrys pod stropem; kolor nasycony (bez lawendy)
      pillar: { trimScale: 0.6, topGap: 0.05, intensity: 0.85, lumMax: 1.15, saturation: 1.6 },
      boundaryTrimHeights: [0.12, 2.6],
      rubber: { color: '#0d0c1c', roughness: 0.85, glow: 0.03, baseHeight: 0.1, baseDepth: 0.022,
        cornerSize: 0.05, cornerInset: 0.012, topGap: 0.04, junctionProbe: 0.08, lineSize: 0.014, lineIntensity: 0.3 },
      paintMargin: { edge: 0.09, bottom: 0.17, strip: 0.09, maxY: 4.4 },   // farba nie dochodzi do krawędzi/listew (m)
      // przygaszenie bliskich listew; udział mgły; cieniowanie „rurki" (boki ciemniejsze → gradient rdzeń/brzeg)
      neon: { nearMin: 0.6, near: [0.6, 3.5], fog: 0.65, tubeEdge: 0.55, tubePow: 0.6 },
      ceilingPool: { radius: 2.8, strength: 0.06, panelRef: 0.006 },            // plamy światła lamp na stropie
      spawnPanel: { width: 1.6, height: 0.9, depth: 0.04, y: 1.45, intensity: 0.9, marker: 0.16, trimScale: 0.8 },
      rampWarn: { inset: 0.08, lift: 0.01, width: 0.06, height: 0.012, k: 0.8 },   // pasy ostrzegawcze na końcach ramp
      platformWarn: { spacing: 1.8, length: 0.32, k: 0.75 },   // krótkie skośne pasy ostrzegawcze na czołach galerii
      rail: { kick: 0.25, postSpacing: 1.2, post: 0.06, rail: 0.05, midY: 0.5, meshAlphaTest: 0.35 },   // barierki: ażur
      floorRoughness: 0.75,         // × roughnessMap (≈0.6) → ~0.45 (półpołysk)
      floorMetalness: 0.2,
      floorEmissiveIntensity: 0.16,
      floorEnvIntensity: 0.25,      // PMREM (ogólny połysk); odbicia neonów robi RT (reflect)
      // odbicie planarne podłogi (preset.envReflections): RT w skali rozdz., rozmycie mipmapą + smuga pionowa (taps),
      // zanik z odległością od podłogi (głębia RT), farba przygaszona w odbiciu (odbijają się głównie listwy)
      reflect: { scale: 0.5, mipBias: 2.4, streak: 9, taps: 9, strength: 0.45, f0: 0.25, maskSoft: 0.45,
        fadeLen: 5.0, paintInReflection: 0.25, maxValue: 16 },
      accentPolicy: { default: 'full', uvmaze: 'paint' },   // 'paint' = akcent tylko w farbie; 'full' = też listwy/światła
      darkNormRef: 0.15,            // emisja tła w kolorze uv × min(1, ref / luminancja uv) (jasny uv → ciemniej)
      darkNormMin: 0.25,
      steelMinY: 1.5,               // bryły z y0 > tego (galerie, barierki na galerii) → stalowa konstrukcja
      steel: { color: '#5a5a68', metalness: 0.3, roughness: 0.62, glow: 0.12, tile: 1.0,
        beam: { spacing: 1.6, width: 0.1, depth: 0.16 } },
      envBakeHeight: 1.6,
      envBlur: 0.02,
      envNear: 0.05,
      envFarScale: 1.5,             // far PMREM = max(szer., gł. areny) × to
      bakeSearch: { maxRadius: 12, step: 0.5, margin: 0.6 },   // szukanie punktu bake envMap poza bryłami
      ceilingTile: 4.8,
      ceilingGlow: 1.8,             // emisja paneli sufitu (tekstura × palette.uv)
      ceilingRoughness: 0.95,
      trussColor: '#2a2638',
      trussGlow: 0.035,             // emisja kratownicy (palette.uv × darkNorm) — sylwetki belek czytelne w ciemności
      trussRoughness: 0.5,
      trussMetalness: 0.6,
      trussBrace: 0.6,              // przekrój krzyżulców × pas
      trussHanger: 0.035,           // zawiesia do stropu (m)
      trussCross: [1.2, 1.6],       // poprzeczne belki stropowe (× pas)
      trussEdge: 0.5,               // min. odstęp dźwigara od ściany obwodowej (m)
      trussSpacing: 4,
      trussWidth: 0.4,
      trussDepth: 0.4,
      trussDrop: 0.15,
      trussChord: 0.06,
      trussBay: 0.8,
      lampSize: [0.9, 0.14, 0.05],  // długość, szerokość, grubość (m)
      lampIntensity: 1.7,
      lampMount: { minSpan: 0.5, crossbar: 0.08, housingHeight: 0.12, housingPad: 0.06 },
      // świetlówki UV pod osią dźwigara: oprawa na 2 wspornikach, regularny rytm
      uvTube: { length: 1.2, thickness: 0.035, spacing: 4, housing: 0.06, housingWidth: 0.1, housingPad: 0.05,
        drop: 0.12, bracket: 0.03, bracketInset: 0.15, intensity: 1.5, lampClear: [1.5, 2.5] },
      conesMinSmoke: 48,            // stożki światła tylko gdy preset.smoke ≥ (High/Ultra)
      coneSegments: 24,
      coneTopRadius: 0.22,
      coneBottomRadius: 1.7,
      coneBottom: 0.0,
      coneOpacity: 0.45,
      coneMargin: 0.15,             // stożek ≥ tyle od brył (brak twardych przecięć)
      coneMinHeight: 0.8,
      coneCheckRadius: 1.0,         // promień sprawdzania kolizji stożka z bryłami (m)
      // tablice (decale) na ścianach obwodowych: symbol sektora + znaki — orientacja w hali
      signs: { maps: ['reactor', 'neonhive'], size: 2.2, y: 2.6, intensity: 1.1, texSize: 512 },
    },
  },

  presets: {
    low: {
      pixelRatio: 0.75, aa: 'none', bloom: null,
      smoke: 0, pointLights: 0, envReflections: false, texSize: 256, anisotropy: 1,
    },
    medium: {
      pixelRatio: 1.0, aa: 'fxaa', bloom: { strength: 0.75, radius: 0.0, threshold: 0.42, scale: 0.5 },
      smoke: 24, pointLights: 2, envReflections: false, texSize: 512, anisotropy: 2,
    },
    high: {
      pixelRatio: 1.5, aa: 'msaa', bloom: { strength: 0.82, radius: 0.0, threshold: 0.4, scale: 1.0 },
      smoke: 48, pointLights: 4, envReflections: true, texSize: 1024, anisotropy: 4,
    },
    ultra: {
      pixelRatio: 2.0, aa: 'msaa', bloom: { strength: 0.9, radius: 0.0, threshold: 0.4, scale: 1.0 },
      smoke: 96, pointLights: 6, envReflections: true, texSize: 1024, anisotropy: 8,
    },
  },

  budget: {
    low:    { calls: 60,  triangles: 120000, textures: 20, geometries: 80 },
    medium: { calls: 90,  triangles: 200000, textures: 28, geometries: 80 },
    high:   { calls: 120, triangles: 350000, textures: 36, geometries: 90 },
    ultra:  { calls: 160, triangles: 600000, textures: 44, geometries: 100 },
  },

  smoke: {
    sizeMin: 3.5,
    sizeMax: 7.0,
    opacity: 0.07,
    drift: 0.18,            // m/s
    heightMin: 0.4,
    heightMax: 3.2,
    driftRadius: 1.4,       // promień wolnej orbity kłębu (m); prędkość = drift
    spin: 0.05,             // maks. prędkość obrotu tekstury (rad/s)
    baseGlow: 2.2,          // jasność bazowa (× darkNorm mapy)
    lightGain: 3.5,         // ile koloru lampy łapie dym
    lightRangeScale: 0.9,
    lightDrop: 1.0,
    nearFade: [1.2, 3.5],   // zanik przy kamerze (m, głębia środka kłębu)
    margin: 1.0,
    wallClearance: 0.6,     // min. odstęp środka kłębu od bryły
    planeFade: 0.6,         // zanik kłębu przy podłodze i suficie (m)
    sizeFloor: 0.9,         // min. rozmiar kłębu w ciasnych miejscach
    sizePerClearance: 2.4,  // rozmiar ≤ (prześwit − dryf) × to (brak przecięć ze ścianami)
    lowBand: [0.25, 1.0],   // warstwa dolna (m) — równomierna przyziemna mgiełka
    highBand: [3.0, 4.2],   // warstwa podsufitowa (m)
    lowShare: 0.6,
    highShare: 0.25,
    aspect: [2.2, 3.6],     // kłęby jako poziome smugi (szerokość / wysokość)
    tilt: 0.25,             // maks. przechył smugi (rad)
    fogMix: 0.6,            // odcień bazowy = lerp(uv palety, mgła, fogMix) — ciemny, chłodny
    maxLights: 8,           // lampy łapane przez dym (uniform array)
    seedSalt: 0x5307e,
  },

  // Efekty strzału (render/beams.js). Jasności > 1 = HDR → bloom.
  fx: {
    beamWidth: 0.11,          // szerokość wstęgi poświaty (m)
    beamCore: 0.15,           // względna szerokość białego rdzenia (0..1 szerokości)
    beamCoreIntensity: 3.0,
    beamGlowIntensity: 1.5,       // poświata nasycona (Neutral TM wybiela wartości ≫ 1)
    beamTaper: 1.6,           // m od lufy, na których wstęga rośnie od beamTaperMin do pełnej szerokości
    beamTaperMin: 0.15,
    beamRows: [0.3, 0.7],     // m od lufy: dodatkowe wiersze geometrii wstęgi w strefie zwężenia (< beamTaper)
    beamNearFade: [0.4, 2.5], // m od kamery: wstęga przygaszona przy samej kamerze (własne strzały nie oślepiają)
    beamNearMin: 0.3,         // jasność wstęgi przy samej kamerze (× pełnej)
    muzzleFlashSize: 0.16,    // m
    muzzleFlashTime: 0.06,    // s
    flashNearDist: 2.5,       // m — bliżej kamery błyski maleją (do flashNearMin przy samej lufie FPP)
    flashNearMin: 0.3,
    muzzleFlashGrow: [0.7, 0.6], // rozmiar błysku lufy w czasie życia k: size × (a + b·k)
    endFlashGrow: [0.8, 0.6],    // jw. dla poświaty końca wiązki
    muzzleFlashIntensity: 2.2,
    endFlashSize: 0.22,       // poświata w punkcie końca wiązki (ściana)
    endFlashIntensity: 1.4,
    sparkLife: 0.42,          // s
    sparkFragments: 12,       // odłamków na trafienie (geometria, nie CPU)
    sparkSpeed: [2.0, 6.0],   // m/s
    sparkGravity: 9.0,
    sparkStreak: 0.03,        // s — długość smugi = prędkość × to
    sparkWidth: 0.014,        // m
    sparkIntensity: 3.0,
    hitFlashSize: 0.6,        // m — rozbłysk w punkcie trafienia
    hitFlashTime: 0.16,
    hitFlashIntensity: 2.6,
    wallPower: 0.35,          // siła iskier przy trafieniu w ścianę (hit=false) względem trafienia w uczestnika
  },

  // Awatary uczestników (render/avatars.js).
  avatar: {
    bodyColor: '#0c0a14',     // ciemny matowy korpus (× kolor drużyny przez instanceColor)
    bodyTint: 0.1,            // ile koloru drużyny w diffuse korpusu (0 = sam bodyColor, 1 = bodyColor × kolor)
    roughness: 0.8,
    rimIntensity: 0.3,        // poświata krawędzi (fresnel) w kolorze drużyny
    rimPower: 4.0,
    visorIntensity: 1.3,      // wizjer/końcówka lufy — nasycone, bez przepalenia do bieli z bliska
    trimIntensity: 0.8,       // pasek na broni (pas = × 0.6)
    sensorLit: 1.8,
    sensorOff: 0.035,
    sensorFlash: 4.0,
    shoulderTilt: 0.75,       // rad — pochylenie padów na ramionach ku górze
    hideDist: 0.6,            // m (XZ) — kamera bliżej osi awatara → awatar pominięty (bot przechodzi przez gracza)
    hideMarginY: 0.3,         // m — zapas pionowy zakresu ukrywania (stopy − to … głowa + to)
    headBase: 1.6,            // m — powyżej: hełm przesuwany sztywno przy kucaniu; poniżej: skalowanie w pionie
    hipHeight: 0.86,          // m — biodra (kolana wypychane poniżej)
    kneeBend: 0.16,           // m — wypchnięcie kolan do przodu przy pełnym kucnięciu
    elimBlinkHz: 6,
    elimDim: 0.12,            // jasność w fazie „zgaszonej” mrugania
    protectPulseHz: 3,
    protectBoost: 1.2,        // amplituda pulsowania ochrony
  },

  // Broń FPP (render/viewModel.js). Lufa kończy się w CONFIG.weapon.muzzleOffset.
  viewModel: {
    scale: 0.42,              // skala względem wylotu lufy
    offset: [0.015, -0.035, 0.0], // przesunięcie broni względem CONFIG.weapon.muzzleOffset (niżej w kadrze); viewModel.muzzleWorld() zwraca faktyczny wylot
    bodyColor: '#0e0c16',
    roughness: 0.75,
    metalness: 0.1,
    trimIntensity: 0.45,      // cienkie akcenty — nasycone, nie białe
    rimIntensity: 0.06,       // fresnel w kolorze gracza
    fillColor: '#0b0816',     // sztuczne światło wypełniające (emisja, układ kamery) — liniowe ≈ 0.01–0.03
    heatIntensity: 0.9,
    hotColor: '#ff2a12',
    flashIntensity: 2.0,
    flashTime: 0.07,
    recoilKick: 0.03,         // m do tyłu
    recoilPitch: 0.09,        // rad
    recoilReturn: 18,         // 1/s
    bobAmp: 0.012,
    bobFreq: 1.6,             // Hz przy prędkości chodu
    overheatBlinkHz: 5,
    overheatBlink: [1.4, 0.25],   // jasność paska ciepła w fazie on/off mrugania
    rimPower: 2.0,
    fillBase: 0.35,           // światło wypełniające: część bezkierunkowa (reszta zależna od normal.y)
    trimFlashBoost: 0.4,      // akcenty × (1 + to × błysk strzału)
    heatRamp: [0.45, 0.95],   // ciepło, przy którym pasek przechodzi z koloru gracza w hotColor
    barOff: 0.03,             // jasność zgaszonej części paska ciepła (× kolor gracza)
    flashWhite: 0.35,         // domieszka bieli w błysku wylotu
    flashIdle: 0.12,          // jasność pierścienia wylotu bez strzału (× flashIntensity)
    bobSmooth: 8,             // 1/s — wygładzanie amplitudy kołysania
    bobMinRate: 0.2,          // min. tempo fazy kołysania (× bobFreq)
    bobSide: 0.6,             // amplituda boczna kołysania (× bobAmp)
    stunDim: 0.15,            // jasność akcentów broni podczas hit stun (P.stunTimer > 0)
    stunFade: 20,             // 1/s — tempo przejścia do/z przygaszenia
    depthRange: 0.05,         // broń zajmuje przednie depthRange zakresu głębi NDC (nie wbija się w ściany)
  },

  // HUD (ui/hud.js).
  hud: {
    hitmarkerTime: 0.2,
    dmgDirTime: 1.1,
    hpFlashTime: 0.3,
    heatWarn: 0.8,
    feedSize: 4,
    feedTime: 4.0,
    feedFade: 0.6,
  },

  pools: {
    beams: 48,
    sparks: 64,
  },

  defaults: {
    map: 'uvmaze',
    preset: 'high',
    mode: 'ffa',
    diff: 'normal',
    bots: null,             // null → liczba z trybu (CONFIG.modes)
  },
});
