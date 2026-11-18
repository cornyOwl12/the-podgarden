// ============================================================================
// podGAN swarm: 1024 procedurally generated creatures that swim like cephalopods
// ============================================================================
// A podGAN is grown from its number (the seed) by an integer hash that gives the same answers here and in the
// shader (W_SWARM), so the CPU and GPU agree on what each one is. The JS side only needs what moves it: its species,
// personality, size and swimming rhythm. Its looks are worked out per pixel on the GPU.
const NPOD = 1024;
const pcg = (v) => { const s = (Math.imul(v, 747796405) + 2891336453) >>> 0; const w = Math.imul(((s >>> ((s >>> 28) + 4)) ^ s) >>> 0, 277803737) >>> 0; return ((w >>> 22) ^ w) >>> 0; };
// k-th random number in [0,1) of seed s (24 bits, exact in f32 too)
const ih = (s, k) => (pcg((pcg(s) + k) >>> 0) >>> 8) / 16777216;
const SPECIES = ['hexapod', 'sep7epod', 'octopoid', 'squidder', 'cuddlefish', 'kraken', 'nautiloid', 'phantapod'];
const MOODS = ['drifting', 'shifty', 'dancing', 'splitting', 'shimmering', 'amorphous', 'ancient', 'gazing', 'probing'];
function podGenome(s) {
  const ty = floor(ih(s, 0) * 8), ad = floor(ih(s, 1) * 9);
  let size = 0.075 + ih(s, 2) * 0.03;
  if (ty === 5) size *= 1.5; if (ty === 6) size *= 1.15; if (ad === 6) size *= 1.4;
  // jet rhythm: seconds per pulse, and the speed one pulse gives (m/s)
  let per = 1.6 + ih(s, 3) * 1.2, jet = 1.6 + ih(s, 18) * 1.2;
  if (ad === 0) { per *= 1.6; jet *= 0.6; } if (ad === 6) { per *= 1.5; jet *= 0.8; } if (ty === 3) { per *= 0.7; jet *= 1.5; } if (ty === 5) jet *= 1.2;
  return { ty, ad, size, per, jet, name: `${MOODS[ad]} ${SPECIES[ty]}` };
}
