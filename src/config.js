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
    dummy: {                // manekin treningowy (game/input/dummyInput.js)
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
      easy:   { reaction: 0.65, aimSigmaDeg: 5.5, turnDegPerSec: 160, viewDist: 28, fovDeg: 100, strafe: 0,   coverHp: 1, coverOnOverheat: false },
      normal: { reaction: 0.40, aimSigmaDeg: 3.0, turnDegPerSec: 260, viewDist: 38, fovDeg: 120, strafe: 0.5, coverHp: 2, coverOnOverheat: false },
      hard:   { reaction: 0.24, aimSigmaDeg: 1.6, turnDegPerSec: 400, viewDist: 48, fovDeg: 140, strafe: 0.8, coverHp: 2, coverOnOverheat: true },
    },
    chaseTime: 4.0,
    burstShots: [2, 5],
    burstPause: [0.35, 0.9],
    thinkInterval: 0.1,     // s między decyzjami FSM (rozłożone między botów)
    arriveDist: 0.6,
    stuckTime: 1.2,
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
    fogDensity: 0.06,
    clearColor: '#05030a',
    msaaSamples: 4,
    bloomFactors: [1.0, 0.75, 0.42, 0.18, 0.06], // wagi 5 mipów UnrealBloomPass (domyślnie 1/.8/.6/.4/.2)
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
    },
    // Arena (render/arenaBuilder.js)
    arena: {
      wallColor: '#07060d',
      wallRoughness: 0.82,
      paintIntensity: 0.75,         // emissive × farba UV (HDR → bloom)
      boundaryPaintScale: 1.875,    // ściany obwodowe: kafel 11.25 × 4.5 m (duże murale)
      trimSize: 0.05,
      trimGap: 0.006,               // odsunięcie listwy od ściany (bez z-fightingu)
      trimBottomLift: 0.03,
      trimIntensity: 1.8,           // vertexColors HDR (> 1 → bloom)
      trimUvBoost: 1.5,             // fiolet jest ciemny percepcyjnie
      trimAccentScale: 0.8,
      pillarTrimTop: 4.5,
      pillarRings: [2.4],
      boundaryTrimHeights: [0.06, 2.6],
      floorRoughness: 0.6,          // × roughnessMap (≈0.6) → ~0.35
      floorMetalness: 0.3,
      floorEmissiveIntensity: 0.2,
      floorEnvIntensity: 1.0,
      // odbicia planarne (preset.envReflections): krycie podłogi nad lustrzaną kopią sceny
      floorReflect: { alphaGloss: 0.85, alphaRough: 0.96, fresnel: 0.25, alphaMin: 0.65 },
      envBakeHeight: 1.6,
      envBlur: 0.02,
      ceilingTile: 4.8,
      trussColor: '#2a2638',
      trussGlow: 0.05,              // emisja kratownicy (palette.uv) — sylwetki belek czytelne w ciemności
      ceilingGlow: 2.8,             // emisja paneli sufitu (tekstura × palette.uv)
      trussSpacing: 4,
      trussWidth: 0.4,
      trussDepth: 0.4,
      trussDrop: 0.15,
      trussChord: 0.06,
      trussBay: 0.8,
      lampSize: [0.9, 0.12, 0.05],  // długość, szerokość, grubość (m)
      lampIntensity: 4.0,
      uvTube: { length: 1.2, thickness: 0.035, spacing: 6, drop: 0.06, intensity: 2.2 }, // świetlówki UV na kratownicy
      conesMinSmoke: 48,            // stożki światła tylko gdy preset.smoke ≥ (High/Ultra)
      coneTopRadius: 0.25,
      coneBottomRadius: 1.9,
      coneBottom: 0.0,
      coneOpacity: 0.25,
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
