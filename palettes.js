// shared palette definitions for the ASCII / oxo family of pages.
// each palette is parameterised by:
//   ramp[0..4] — five brightness stops (low → high)
//   bg         — background color (used when charMask = 0)
//   tearA      — primary glitch / chromatic-aberration hot color
//   tearB      — channel-split partner color
//   tearBand   — color of the rolling glitch band
//   lightBg    — true → cream/light page; overlay UI must invert
//
// 8 colors per palette is the surface area; pages can mix this however they like.

window.PALETTES = [
  // 0 — oxocarbon (the original; tear hits cyan/magenta to mirror the ramp)
  {
    id: 'oxo', name: 'oxocarbon', lightBg: false,
    bg: [0.086, 0.086, 0.094],
    ramp: [
      [0.087, 0.087, 0.100],
      [0.745, 0.584, 1.000],
      [1.000, 0.494, 0.714],
      [0.239, 0.859, 0.851],
      [0.960, 0.950, 0.850],
    ],
    tearA:    [1.00, 0.30, 0.55],
    tearB:    [0.20, 0.85, 1.00],
    tearBand: [1.00, 0.40, 0.70],
  },
  // 1 — oxo-analog (keeps oxocarbon's violet/pink/cyan, compressing them into a quieter adjacent harmony)
  {
    id: 'oxo-analog', name: 'oxo · analog', lightBg: false,
    bg: [0.058, 0.052, 0.074],
    ramp: [
      [0.058, 0.052, 0.074],
      [0.545, 0.455, 0.840],
      [0.870, 0.390, 0.660],
      [0.420, 0.760, 0.840],
      [0.925, 0.905, 0.810],
    ],
    tearA:    [0.95, 0.34, 0.64],
    tearB:    [0.34, 0.82, 0.94],
    tearBand: [0.78, 0.46, 0.82],
  },
  // 2 — oxo-split (split-complement: oxo magenta/cyan with acidic yellow-green lift)
  {
    id: 'oxo-split', name: 'oxo · split', lightBg: false,
    bg: [0.042, 0.050, 0.064],
    ramp: [
      [0.042, 0.050, 0.064],
      [0.475, 0.330, 0.780],
      [0.930, 0.350, 0.600],
      [0.600, 0.920, 0.430],
      [0.960, 0.940, 0.800],
    ],
    tearA:    [0.98, 0.34, 0.58],
    tearB:    [0.58, 0.95, 0.40],
    tearBand: [0.32, 0.84, 0.90],
  },
  // 3 — oxo-triad (triadic rotation: violet, cyan, and warm amber with oxo cream at the top)
  {
    id: 'oxo-triad', name: 'oxo · triad', lightBg: false,
    bg: [0.048, 0.042, 0.056],
    ramp: [
      [0.048, 0.042, 0.056],
      [0.520, 0.380, 0.850],
      [0.240, 0.820, 0.840],
      [0.960, 0.650, 0.240],
      [0.970, 0.940, 0.820],
    ],
    tearA:    [0.98, 0.44, 0.24],
    tearB:    [0.24, 0.86, 0.90],
    tearBand: [0.78, 0.54, 0.90],
  },
  // 4 — oxo-calm (lower-chroma oxocarbon; same relationships, less saturation for a softer read)
  {
    id: 'oxo-calm', name: 'oxo · calm', lightBg: false,
    bg: [0.074, 0.074, 0.082],
    ramp: [
      [0.074, 0.074, 0.082],
      [0.560, 0.500, 0.740],
      [0.760, 0.455, 0.600],
      [0.410, 0.700, 0.700],
      [0.900, 0.890, 0.805],
    ],
    tearA:    [0.84, 0.40, 0.58],
    tearB:    [0.38, 0.74, 0.82],
    tearBand: [0.72, 0.48, 0.66],
  },
  // 5 — oxo-paper (light oxocarbon: ink values on warm paper with retained cyan/magenta accents)
  {
    id: 'oxo-paper', name: 'oxo · paper', lightBg: true,
    bg: [0.925, 0.905, 0.845],
    ramp: [
      [0.835, 0.810, 0.735],
      [0.600, 0.520, 0.760],
      [0.760, 0.330, 0.520],
      [0.110, 0.620, 0.640],
      [0.055, 0.060, 0.075],
    ],
    tearA:    [0.800, 0.260, 0.500],
    tearB:    [0.080, 0.650, 0.700],
    tearBand: [0.600, 0.520, 0.760],
  },
  // 6 — oxo-day (cool light theme; cyan carries contrast, violet/pink stay as midtones)
  {
    id: 'oxo-day', name: 'oxo · day', lightBg: true,
    bg: [0.900, 0.940, 0.940],
    ramp: [
      [0.820, 0.900, 0.900],
      [0.540, 0.760, 0.820],
      [0.720, 0.430, 0.740],
      [0.780, 0.240, 0.500],
      [0.045, 0.060, 0.082],
    ],
    tearA:    [0.820, 0.240, 0.500],
    tearB:    [0.060, 0.620, 0.700],
    tearBand: [0.540, 0.760, 0.820],
  },
  // 7 — oxo-pearl (near-monochrome light theme with tiny oxo chroma for restrained contrast)
  {
    id: 'oxo-pearl', name: 'oxo · pearl', lightBg: true,
    bg: [0.950, 0.945, 0.920],
    ramp: [
      [0.900, 0.890, 0.850],
      [0.690, 0.670, 0.720],
      [0.480, 0.430, 0.560],
      [0.260, 0.330, 0.360],
      [0.060, 0.060, 0.070],
    ],
    tearA:    [0.760, 0.300, 0.520],
    tearB:    [0.120, 0.600, 0.640],
    tearBand: [0.480, 0.430, 0.560],
  },
  // 8 — oxo-solar (light complementary variant: violet ink against a warm daylight ground)
  {
    id: 'oxo-solar', name: 'oxo · solar', lightBg: true,
    bg: [0.965, 0.920, 0.800],
    ramp: [
      [0.910, 0.840, 0.680],
      [0.800, 0.570, 0.360],
      [0.650, 0.330, 0.560],
      [0.300, 0.450, 0.680],
      [0.055, 0.050, 0.070],
    ],
    tearA:    [0.760, 0.260, 0.520],
    tearB:    [0.200, 0.560, 0.760],
    tearBand: [0.900, 0.620, 0.320],
  },
  // 1 — dusk (indigo → violet → rose → amber → cream)
  {
    id: 'dusk', name: 'dusk', lightBg: false,
    bg: [0.060, 0.040, 0.180],
    ramp: [
      [0.060, 0.040, 0.180],
      [0.420, 0.200, 0.620],
      [0.950, 0.420, 0.550],
      [0.960, 0.650, 0.300],
      [0.990, 0.930, 0.750],
    ],
    tearA:    [0.98, 0.42, 0.30],
    tearB:    [0.55, 0.40, 0.95],
    tearBand: [0.99, 0.62, 0.40],
  },
  // 2 — aurora (navy → teal → green → pale yellow → cream)
  {
    id: 'aurora', name: 'aurora', lightBg: false,
    bg: [0.040, 0.060, 0.160],
    ramp: [
      [0.040, 0.060, 0.160],
      [0.100, 0.550, 0.550],
      [0.300, 0.920, 0.500],
      [0.850, 1.000, 0.500],
      [0.980, 0.980, 0.920],
    ],
    tearA:    [0.30, 0.95, 0.55],
    tearB:    [0.20, 0.85, 1.00],
    tearBand: [0.85, 1.00, 0.55],
  },
  // 3 — ember (charcoal → red-violet → red → orange → cream)
  {
    id: 'ember', name: 'ember', lightBg: false,
    bg: [0.100, 0.040, 0.060],
    ramp: [
      [0.100, 0.040, 0.060],
      [0.450, 0.100, 0.350],
      [0.950, 0.300, 0.200],
      [0.990, 0.750, 0.180],
      [1.000, 0.950, 0.650],
    ],
    tearA:    [1.00, 0.40, 0.15],
    tearB:    [1.00, 0.85, 0.20],
    tearBand: [0.95, 0.30, 0.20],
  },
  // 4 — vapor (deep purple → magenta → pink → cyan → mint)
  {
    id: 'vapor', name: 'vapor', lightBg: false,
    bg: [0.080, 0.040, 0.200],
    ramp: [
      [0.080, 0.040, 0.200],
      [0.950, 0.300, 0.650],
      [1.000, 0.550, 0.750],
      [0.550, 0.950, 0.950],
      [0.920, 0.990, 0.880],
    ],
    tearA:    [1.00, 0.35, 0.85],
    tearB:    [0.40, 0.95, 1.00],
    tearBand: [1.00, 0.55, 0.95],
  },
  // 5 — orokin (ink-on-cream parchment; LIGHT BG)
  // tear stays in the bronze family so the click reads as a deepening of the ink, not a clash
  {
    id: 'orokin', name: 'orokin', lightBg: true,
    bg: [0.910, 0.890, 0.810],
    ramp: [
      [0.860, 0.830, 0.730],
      [0.740, 0.640, 0.400],
      [0.550, 0.420, 0.160],
      [0.360, 0.220, 0.060],
      [0.200, 0.110, 0.030],
    ],
    tearA:    [0.360, 0.220, 0.060],
    tearB:    [0.550, 0.420, 0.160],
    tearBand: [0.860, 0.830, 0.730],
  },
  // 6 — gilt (Byzantine gold on near-black)
  {
    id: 'gilt', name: 'gilt', lightBg: false,
    bg: [0.040, 0.030, 0.010],
    ramp: [
      [0.040, 0.030, 0.010],
      [0.300, 0.160, 0.040],
      [0.650, 0.400, 0.060],
      [1.000, 0.780, 0.120],
      [1.000, 0.960, 0.550],
    ],
    tearA:    [1.00, 0.80, 0.10],
    tearB:    [1.00, 0.40, 0.10],
    tearBand: [1.00, 0.96, 0.55],
  },
  // 7 — daybrk (sunrise pastels)
  {
    id: 'daybrk', name: 'daybrk', lightBg: false,
    bg: [0.160, 0.070, 0.120],
    ramp: [
      [0.160, 0.070, 0.120],
      [0.550, 0.260, 0.420],
      [0.950, 0.550, 0.450],
      [1.000, 0.800, 0.550],
      [1.000, 0.950, 0.850],
    ],
    tearA:    [1.00, 0.50, 0.55],
    tearB:    [0.55, 0.35, 0.85],
    tearBand: [1.00, 0.70, 0.50],
  },

  // 8 — noir (pure monochrome; CRT-style tear that punches with neon)
  {
    id: 'noir', name: 'noir', lightBg: false,
    bg: [0.020, 0.020, 0.020],
    ramp: [
      [0.020, 0.020, 0.020],
      [0.180, 0.180, 0.180],
      [0.420, 0.420, 0.420],
      [0.750, 0.750, 0.750],
      [1.000, 1.000, 1.000],
    ],
    tearA:    [1.00, 0.10, 0.45],
    tearB:    [0.10, 0.85, 1.00],
    tearBand: [1.00, 1.00, 1.00],
  },
  // 9 — sakura (cherry blossom / Heian poetry)
  {
    id: 'sakura', name: 'sakura', lightBg: false,
    bg: [0.100, 0.040, 0.100],
    ramp: [
      [0.100, 0.040, 0.100],
      [0.550, 0.200, 0.400],
      [0.950, 0.550, 0.750],
      [1.000, 0.820, 0.880],
      [1.000, 0.970, 0.960],
    ],
    tearA:    [1.00, 0.30, 0.65],
    tearB:    [0.65, 0.50, 1.00],
    tearBand: [1.00, 0.55, 0.80],
  },
  // 10 — moss (forest floor / lichen)
  {
    id: 'moss', name: 'moss', lightBg: false,
    bg: [0.040, 0.070, 0.050],
    ramp: [
      [0.040, 0.070, 0.050],
      [0.180, 0.300, 0.160],
      [0.450, 0.550, 0.200],
      [0.780, 0.820, 0.450],
      [0.950, 0.970, 0.800],
    ],
    tearA:    [0.65, 0.95, 0.30],
    tearB:    [0.95, 0.65, 0.20],
    tearBand: [0.78, 0.82, 0.45],
  },
  // 11 — abyss (deep ocean + bioluminescence)
  {
    id: 'abyss', name: 'abyss', lightBg: false,
    bg: [0.010, 0.030, 0.080],
    ramp: [
      [0.010, 0.030, 0.080],
      [0.040, 0.200, 0.400],
      [0.100, 0.550, 0.750],
      [0.550, 0.850, 0.950],
      [0.920, 0.980, 1.000],
    ],
    tearA:    [0.20, 1.00, 0.80],
    tearB:    [0.30, 0.55, 1.00],
    tearBand: [0.55, 0.85, 0.95],
  },
  // 12 — terra (clay, ochre, sand)
  {
    id: 'terra', name: 'terra', lightBg: false,
    bg: [0.070, 0.050, 0.040],
    ramp: [
      [0.070, 0.050, 0.040],
      [0.420, 0.180, 0.100],
      [0.780, 0.420, 0.220],
      [0.950, 0.750, 0.550],
      [0.990, 0.950, 0.850],
    ],
    tearA:    [0.95, 0.30, 0.18],
    tearB:    [0.95, 0.75, 0.30],
    tearBand: [0.78, 0.42, 0.22],
  },
  // 13 — monolith (black ink on cream; LIGHT BG, brutalist)
  {
    id: 'monolith', name: 'monolith', lightBg: true,
    bg: [0.940, 0.930, 0.900],
    ramp: [
      [0.880, 0.860, 0.820],
      [0.620, 0.600, 0.580],
      [0.380, 0.360, 0.340],
      [0.180, 0.170, 0.160],
      [0.050, 0.050, 0.050],
    ],
    // single ink-stamp red, no chromatic split partner
    tearA:    [0.85, 0.18, 0.20],
    tearB:    [0.30, 0.30, 0.30],
    tearBand: [0.85, 0.18, 0.20],
  },
  // 14 — frost (icy blue / glacier)
  {
    id: 'frost', name: 'frost', lightBg: false,
    bg: [0.040, 0.060, 0.120],
    ramp: [
      [0.040, 0.060, 0.120],
      [0.180, 0.300, 0.550],
      [0.450, 0.650, 0.920],
      [0.720, 0.900, 1.000],
      [0.970, 0.990, 1.000],
    ],
    tearA:    [0.30, 0.85, 1.00],
    tearB:    [0.85, 0.30, 0.95],
    tearBand: [0.45, 0.65, 0.92],
  },
  // 15 — velvet (burgundy / wine + champagne)
  {
    id: 'velvet', name: 'velvet', lightBg: false,
    bg: [0.060, 0.020, 0.040],
    ramp: [
      [0.060, 0.020, 0.040],
      [0.300, 0.050, 0.100],
      [0.620, 0.150, 0.250],
      [0.920, 0.550, 0.450],
      [0.990, 0.920, 0.780],
    ],
    tearA:    [1.00, 0.18, 0.30],
    tearB:    [0.95, 0.78, 0.30],
    tearBand: [0.62, 0.15, 0.25],
  },
  // 16 — plasma (matplotlib plasma colormap energy)
  {
    id: 'plasma', name: 'plasma', lightBg: false,
    bg: [0.050, 0.020, 0.200],
    ramp: [
      [0.050, 0.020, 0.200],
      [0.450, 0.050, 0.550],
      [0.920, 0.300, 0.400],
      [0.990, 0.750, 0.200],
      [1.000, 1.000, 0.850],
    ],
    tearA:    [1.00, 0.30, 0.65],
    tearB:    [0.30, 0.55, 1.00],
    tearBand: [0.99, 0.75, 0.20],
  },
  // 17 — rune (CRT phosphor green; warning-amber tear)
  {
    id: 'rune', name: 'rune', lightBg: false,
    bg: [0.000, 0.040, 0.020],
    ramp: [
      [0.000, 0.040, 0.020],
      [0.050, 0.180, 0.080],
      [0.120, 0.550, 0.180],
      [0.450, 0.920, 0.350],
      [0.850, 1.000, 0.850],
    ],
    tearA:    [1.00, 0.55, 0.05],
    tearB:    [1.00, 0.18, 0.10],
    tearBand: [0.45, 0.92, 0.35],
  },

  // 18 — oxo-night (oxo's hues, pushed into the dark; bg is near-black, ramp dimmed)
  {
    id: 'oxo-night', name: 'oxo · night', lightBg: false,
    bg: [0.030, 0.030, 0.038],
    ramp: [
      [0.030, 0.030, 0.038],
      [0.460, 0.330, 0.680],
      [0.760, 0.290, 0.500],
      [0.140, 0.560, 0.580],
      [0.760, 0.740, 0.640],
    ],
    tearA:    [0.90, 0.25, 0.50],
    tearB:    [0.18, 0.78, 0.94],
    tearBand: [0.86, 0.34, 0.62],
  },
  // 19 — oxo-velvet (oxo on a wine-purple ground; cyan dropped, lavender brought in)
  {
    id: 'oxo-velvet', name: 'oxo · velvet', lightBg: false,
    bg: [0.060, 0.020, 0.090],
    ramp: [
      [0.060, 0.020, 0.090],
      [0.380, 0.170, 0.480],
      [0.820, 0.330, 0.620],
      [0.560, 0.450, 0.860],
      [0.940, 0.890, 0.920],
    ],
    tearA:    [0.95, 0.30, 0.60],
    tearB:    [0.55, 0.40, 0.95],
    tearBand: [0.82, 0.33, 0.62],
  },
  // 20 — oxo-wisp (the rest of the field crushed into deep purple; the cursor wisp keeps full oxo cyan/cream)
  {
    id: 'oxo-wisp', name: 'oxo · wisp', lightBg: false,
    bg: [0.020, 0.020, 0.025],
    ramp: [
      [0.020, 0.020, 0.025],
      [0.180, 0.100, 0.300],
      [0.450, 0.180, 0.400],
      [0.239, 0.859, 0.851],
      [0.960, 0.950, 0.850],
    ],
    tearA:    [1.00, 0.30, 0.55],
    tearB:    [0.20, 0.85, 1.00],
    tearBand: [1.00, 0.40, 0.70],
  },
  // 21 — oxo-coal (graphite — oxo desaturated to a smoky, monochrome-leaning version)
  {
    id: 'oxo-coal', name: 'oxo · coal', lightBg: false,
    bg: [0.050, 0.055, 0.065],
    ramp: [
      [0.050, 0.055, 0.065],
      [0.450, 0.400, 0.580],
      [0.660, 0.430, 0.520],
      [0.330, 0.560, 0.580],
      [0.780, 0.760, 0.680],
    ],
    tearA:    [0.78, 0.32, 0.50],
    tearB:    [0.30, 0.65, 0.70],
    tearBand: [0.78, 0.42, 0.58],
  },
];
