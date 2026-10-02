% sim_megapress_central.m
% MEGA-PRESS edit-ON and edit-OFF spectra of one spin system with FID-A's
% shaped-pulse simulation (sim_megapress_shaped) at the voxel centre, summed
% over FID-A's 16-step phase cycle of the editing and refocusing pulses as
% run_simMegaPressShaped.m does (the cycle removes unrefocused coherences
% that crusher gradients remove in the scanner). Derived from FID-A's
% run_simMegaPressShaped.m, Copyright 2020 Jamie Near, BSD-3-Clause. Only
% the centre position is simulated: slice-profile effects across the voxel
% are not included. The result is re-centred to 4.65 ppm at 0 Hz (FID-A's
% shaped simulation centres at 3.0 ppm), the convention of the rest of the
% basis library.
%
% [on, off] = sim_megapress_central(set, sys)
function [on, off] = sim_megapress_central(set, sys)
  gamma = 42577000;
  centreFreq = 3.0;
  refRF = rf_resample(io_loadRFwaveform('sampleRefocPulse.pta', 'ref', 0), 100);
  editRF = io_loadRFwaveform('sampleEditPulse.pta', 'inv', 0);
  editRFon = rf_freqshift(editRF, set.edit_tp_ms, (centreFreq - set.edit_on_ppm) * set.field_T * gamma / 1e6);
  editRFoff = rf_freqshift(editRF, set.edit_tp_ms, (centreFreq - set.edit_off_ppm) * set.field_T * gamma / 1e6);
  thk = 3;
  G = (refRF.tbw / (set.refoc_tp_ms / 1000)) / (gamma * thk / 10000);
  edit_ph = [0 90];
  ref_ph = [0 90];
  taus = set.taus_ms(:)';
  on = [];
  off = [];
  for EP1 = 1:2
    for EP2 = 1:2
      onE = [];
      offE = [];
      for RP1 = 1:2
        for RP2 = 1:2
          a = sim_megapress_shaped(set.points, set.bandwidth_Hz, set.field_T, set.linewidth_Hz, taus, sys, ...
            editRFon, set.edit_tp_ms, edit_ph(EP1), edit_ph(EP2), refRF, set.refoc_tp_ms, G, G, 0, 0, ref_ph(RP1), ref_ph(RP2));
          b = sim_megapress_shaped(set.points, set.bandwidth_Hz, set.field_T, set.linewidth_Hz, taus, sys, ...
            editRFoff, set.edit_tp_ms, edit_ph(EP1), edit_ph(EP2), refRF, set.refoc_tp_ms, G, G, 0, 0, ref_ph(RP1), ref_ph(RP2));
          if RP1 == 1 && RP2 == 1
            onE = a;
            offE = b;
          else
            subtract = xor(RP1 == 2, RP2 == 2);
            onE = op_addScans(onE, a, subtract);
            offE = op_addScans(offE, b, subtract);
          end
        end
      end
      if isempty(on)
        on = onE;
        off = offE;
      else
        on = op_addScans(on, onE);
        off = op_addScans(off, offE);
      end
    end
  end
  on = op_ampScale(on, 1 / 16);
  off = op_ampScale(off, 1 / 16);
  shift = (4.65 - centreFreq) * set.field_T * gamma / 1e6;
  on = op_freqshift(on, shift);
  off = op_freqshift(off, shift);
  on.ppm = on.ppm + (4.65 - centreFreq);
  off.ppm = off.ppm + (4.65 - centreFreq);
end
