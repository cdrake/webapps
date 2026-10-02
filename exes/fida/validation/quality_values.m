function V = quality_values(V, out, outw, water)
% QUALITY_VALUES  The final SNR and linewidths the Rust pipeline reports.
%   SNR: op_getSNR defaults (NAA 1.8-2.2 ppm, noise -2-0 ppm). Linewidth:
%   op_getLW of NAA (1.8-2.2 ppm) and, with a water reference, of water
%   (op_getLW defaults, 4.4-5.0 ppm), both zero-filled 8 times.
  [V.snr, V.snr_signal, V.snr_noisesd] = op_getSNR(out, 1.8, 2.2, -2, 0, true);
  V.lw_naa = op_getLW(out, 1.8, 2.2, 8, true);
  if water
    V.lw_water = op_getLW(outw, 4.4, 5.0, 8, true);
  end
end
