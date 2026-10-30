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
    walkSpeed: 5.2,
    sprintSpeed: 7.6,
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
    eventCapacity: 256,     // pierścień zdarzeń symulacji (core/events.js); czyszczony raz na klatkę renderu
    maxParticipants: 16,    // pojemność instancji awatarów
    dummy: {                // manekin treningowy (game/input/dummyInput.js)
      count: 3,             // manekiny w trybie treningowym M1 (zastąpione botami w M2)
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

  colors: {
    teams: ['#ff3355', '#2f8bff', '#3dff7a', '#ffd600'],
    ffa: ['#ff3355', '#2f8bff', '#3dff7a', '#ffd600', '#ff4dff', '#00f0ff', '#ff8a00', '#b0ff00'],
  },

  bots: {
    levels: {
      easy:   { reaction: 0.65, aimSigmaDeg: 5.5, turnDegPerSec: 160, viewDist: 28, fovDeg: 100, strafe: 0,   coverHp: 1, coverOnOverheat: false, heatLimit: 1.0 },
      normal: { reaction: 0.40, aimSigmaDeg: 3.0, turnDegPerSec: 260, viewDist: 38, fovDeg: 120, strafe: 0.5, coverHp: 2, coverOnOverheat: false, heatLimit: 0.9 },
      hard:   { reaction: 0.24, aimSigmaDeg: 1.6, turnDegPerSec: 400, viewDist: 48, fovDeg: 140, strafe: 0.8, coverHp: 2, coverOnOverheat: true, heatLimit: 0.8 },
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
    toneMappingExposure: 1.0,
    fogDensity: 0.055,
    fogTint: 0.07,          // kolor mgły = lerp(palette.fog, palette.uv, fogTint)
    clearColor: '#05030a',
    msaaSamples: 4,
    bloomFactors: [1.0, 0.5, 0.2, 0.07, 0.02],  // wagi 5 mipów UnrealBloomPass (domyślnie 1/.8/.6/.4/.2)
    // Oświetlenie (render/graphics.js): ciemność dominuje — ambient/hemi bardzo słabe.
    lights: {
      hemiIntensity: 0.9,     // HemisphereLight w kolorze palette.ambient
      hemiGround: 0.35,       // ziemia = ambient × to
      pointScale: 1.0,        // intensywność PointLight = light.intensity × to (decay 2)
      rangeScale: 1.0,
      drop: 0.35,             // PointLight pod oprawą lampy (m)
    },
    // Tekstury proceduralne (render/textures.js)
    textures: {
      paintMeters: [6, 2.4],  // kafel farby UV = 6 × 2.4 m
      floorMeters: 2,         // kafel podłogi (linia siatki co 2 m)
      floorLine: 0.012,       // grubość linii siatki podłogi (m)
      smokeSize: 256,
      wallMeters: 2.44,       // kafel faktury ściany (2 płyty 1.22 m)
      accentShare: 0.08,      // udział akcentu wśród drobnych elementów farby
    },
    // Arena (render/arenaBuilder.js)
    arena: {
      wallColor: '#15132a',         // bardzo ciemny granat (× faktura sklejki)
      wallRoughness: 0.85,
      paintIntensity: 0.75,         // emisja farby UV (maski × kolor bryły; HDR → bloom)
      accentPaintScale: 0.8,        // akcent (limonka) tylko w drobnych elementach farby
      uvBoost: 1.45,                // fiolet jest ciemny percepcyjnie (listwy, farba, poświata)
      boundaryPaintScale: 1.875,    // ściany obwodowe: kafel 11.25 × 4.5 m (duże murale)
      // poświata UV/neonu na licu ściany (× kolor listwy bryły × faktura): mocna przy listwie, gaśnie w dół
      wash: { top: 0.09, fall: 0.55, bottom: 0.05, base: 0.008, edge: 0.05, edgeWidth: 0.035 },
      capWash: 0.35,                // poświata na wierzchu brył (× wash)
      trimSize: 0.05,
      trimGap: 0.006,               // odsunięcie listwy od ściany (bez z-fightingu)
      trimBottomLift: 0.05,
      trimIntensity: 1.25,          // vertexColors HDR (> 1 → bloom); rdzeń nasycony, nie biały
      trimSaturation: 1.35,         // podbicie nasycenia listew/lamp (ACES wybiela jasne kolory)
      lampClearance: 0.7,           // oprawa lampy min. tyle od bryły sięgającej sufitu (filar)
      pillarTrimTop: 2.4,           // filar: ramka neonowa do wysokości ścian, wyżej czysty słup
      boundaryTrimHeights: [0.12, 2.6],
      rubber: { color: '#0b0a12', baseHeight: 0.1, baseDepth: 0.022, cornerSize: 0.06, cornerInset: 0.012 },
      spawnPanel: { width: 1.6, height: 0.9, depth: 0.04, y: 1.45, intensity: 1.0 },
      floorRoughness: 0.75,         // × roughnessMap (≈0.6) → ~0.45 (półpołysk)
      floorMetalness: 0.2,
      floorEmissiveIntensity: 0.16,
      floorEnvIntensity: 0.25,      // PMREM (ogólny połysk); odbicia neonów robi RT (reflect)
      // odbicie planarne podłogi (preset.envReflections): RT w skali rozdz., rozmycie mipmapą + smuga pionowa
      reflect: { scale: 0.5, mipBias: 2.2, streak: 10, strength: 0.55, f0: 0.18 },
      envBakeHeight: 1.6,
      envBlur: 0.02,
      ceilingTile: 4.8,
      ceilingGlow: 1.2,             // emisja paneli sufitu (tekstura × palette.uv)
      trussColor: '#2a2638',
      trussGlow: 0.06,              // emisja kratownicy (palette.uv) — sylwetki belek czytelne w ciemności
      trussSpacing: 4,
      trussWidth: 0.4,
      trussDepth: 0.4,
      trussDrop: 0.15,
      trussChord: 0.06,
      trussBay: 0.8,
      lampSize: [0.9, 0.14, 0.05],  // długość, szerokość, grubość (m)
      lampIntensity: 2.6,
      uvTube: { length: 1.2, thickness: 0.035, spacing: 4, housing: 0.05, intensity: 1.8 }, // świetlówki UV pod dźwigarami
      conesMinSmoke: 48,            // stożki światła tylko gdy preset.smoke ≥ (High/Ultra)
      coneTopRadius: 0.22,
      coneBottomRadius: 1.7,
      coneBottom: 0.0,
      coneOpacity: 0.5,
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
    baseGlow: 3.0,          // jasność bazowa (odcień palety uv/primary)
    lightGain: 5.0,         // ile koloru lampy łapie dym
    lightRangeScale: 0.9,
    lightDrop: 1.0,
    nearFade: [1.2, 3.5],   // zanik przy kamerze (m, głębia środka kłębu)
    margin: 1.0,
    wallClearance: 0.6,     // min. odstęp środka kłębu od bryły
    lowBand: [0.3, 1.3],    // warstwa dolna (m)
    highBand: [3.0, 4.2],   // warstwa podsufitowa (m)
    lowShare: 0.45,
    highShare: 0.4,
  },

  // Efekty strzału (render/beams.js). Jasności > 1 = HDR → bloom.
  fx: {
    beamWidth: 0.11,          // szerokość wstęgi poświaty (m)
    beamCore: 0.22,           // względna szerokość białego rdzenia (0..1 szerokości)
    beamCoreIntensity: 3.5,
    beamGlowIntensity: 2.8,
    beamTaper: 1.6,           // m od lufy, na których wstęga rośnie od beamTaperMin do pełnej szerokości
    beamTaperMin: 0.15,
    beamNearFade: [0.4, 2.5], // m od kamery: wstęga przygaszona przy samej kamerze (własne strzały nie oślepiają)
    muzzleFlashSize: 0.16,    // m
    muzzleFlashTime: 0.06,    // s
    flashNearDist: 2.5,       // m — bliżej kamery błyski maleją (do 30% przy samej lufie FPP)
    muzzleFlashIntensity: 4.0,
    endFlashSize: 0.22,       // poświata w punkcie końca wiązki (ściana)
    endFlashIntensity: 2.0,
    sparkLife: 0.42,          // s
    sparkFragments: 12,       // odłamków na trafienie (geometria, nie CPU)
    sparkSpeed: [2.0, 6.0],   // m/s
    sparkGravity: 9.0,
    sparkStreak: 0.03,        // s — długość smugi = prędkość × to
    sparkWidth: 0.014,        // m
    sparkIntensity: 5.0,
    hitFlashSize: 0.6,        // m — rozbłysk w punkcie trafienia
    hitFlashTime: 0.16,
    hitFlashIntensity: 5.0,
    wallPower: 0.35,          // siła iskier przy trafieniu w ścianę (hit=false) względem trafienia w uczestnika
  },

  // Awatary uczestników (render/avatars.js).
  avatar: {
    bodyColor: '#0c0a14',     // ciemny matowy korpus (× kolor drużyny przez instanceColor)
    bodyTint: 0.3,            // ile koloru drużyny w diffuse korpusu (0 = sam bodyColor, 1 = bodyColor × kolor)
    roughness: 0.8,
    rimIntensity: 0.42,       // poświata krawędzi (fresnel) w kolorze drużyny
    rimPower: 2.6,
    visorIntensity: 3.0,
    trimIntensity: 1.1,       // pasek na broni (pas = × 0.6)
    sensorLit: 3.2,
    sensorOff: 0.035,
    sensorFlash: 6.0,
    elimBlinkHz: 6,
    elimDim: 0.12,            // jasność w fazie „zgaszonej” mrugania
    protectPulseHz: 3,
    protectBoost: 1.2,        // amplituda pulsowania ochrony
  },

  // Broń FPP (render/viewModel.js). Lufa kończy się w CONFIG.weapon.muzzleOffset.
  viewModel: {
    scale: 0.62,              // skala względem wylotu lufy
    bodyColor: '#14121e',
    trimIntensity: 0.9,
    rimIntensity: 0.12,       // fresnel w kolorze gracza
    fillColor: '#120e22',     // sztuczne światło wypełniające (emisja, układ kamery) — liniowe ≈ 0.01–0.03
    heatIntensity: 3.0,
    hotColor: '#ff2a12',
    flashIntensity: 6.0,
    flashTime: 0.07,
    recoilKick: 0.045,        // m do tyłu
    recoilPitch: 0.09,        // rad
    recoilReturn: 18,         // 1/s
    bobAmp: 0.012,
    bobFreq: 1.6,             // Hz przy prędkości chodu
    overheatBlinkHz: 5,
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
  },
});
