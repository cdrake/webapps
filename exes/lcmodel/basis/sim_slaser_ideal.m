% sim_slaser_ideal.m
% Ideal-pulse semi-LASER: 90 degree excitation followed by four equally
% spaced 180 degree refocusing pulses (two adiabatic pairs), echo time TE.
% Derived from FID-A's sim_laser.m (six refocusing pulses), Copyright 2020
% Jamie Near, BSD-3-Clause; uses FID-A's sim_Hamiltonian/sim_excite/
% sim_evolve/sim_rotate/sim_readout unchanged.
%
% out = sim_slaser_ideal(n, sw, Bfield, linewidth, sys, TE)
%   n, sw, Bfield, linewidth, sys as in FID-A's sim_press; TE in ms.
function out = sim_slaser_ideal(n, sw, Bfield, linewidth, sys, TE)
  centreFreq = 4.65;
  for k = 1:length(sys)
    sys(k).shifts = sys(k).shifts - centreFreq;
  end
  [H, d] = sim_Hamiltonian(sys, Bfield);
  tau = TE / 4 / 1000;
  d = sim_excite(d, H, 'x');
  d = sim_evolve(d, H, tau / 2);
  for p = 1:4
    d = sim_rotate(d, H, 180, 'y');
    if p < 4
      d = sim_evolve(d, H, tau);
    end
  end
  d = sim_evolve(d, H, tau / 2);
  [out, dout] = sim_readout(d, H, n, sw, linewidth, 90);
  out.ppm = out.ppm - (4.65 - centreFreq);
  out.seq = 'slaser';
  out.te = TE;
  out.sim = 'ideal';
  out.sz = size(out.specs);
  out.dims.t = 1; out.dims.coils = 0; out.dims.averages = 0; out.dims.subSpecs = 0; out.dims.extras = 0;
  out.averages = 1; out.rawAverages = 1; out.subspecs = 1; out.rawSubspecs = 1;
end
