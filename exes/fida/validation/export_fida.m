function export_fida(out, path)
% EXPORT_FIDA  Write a FID-A structure for the Rust port's tests.
%   export_fida(out, 'dir/name') writes dir/name.json (header, dims, sz,
%   flags, ppm/t axis ends) and dir/name.bin (fids as interleaved
%   little-endian float64 real/imag pairs in MATLAB column-major order over
%   out.sz). Only the fields the port compares are exported.
  fids = out.fids(:);
  f = fopen([path '.bin'], 'w', 'ieee-le');
  buf = zeros(2 * numel(fids), 1);
  buf(1:2:end) = real(fids);
  buf(2:2:end) = imag(fids);
  fwrite(f, buf, 'double');
  fclose(f);
  h = struct();
  h.sz = double(out.sz);
  h.dims = out.dims;
  names = {'spectralwidth','dwelltime','txfrq','te','tr','Bo','averages','rawAverages','subspecs','rawSubspecs','pointsToLeftshift'};
  for k = 1:numel(names)
    if isfield(out, names{k}), h.(names{k}) = double(out.(names{k})); end
  end
  if isfield(out, 'seq'), h.seq = char(out.seq); end
  if isfield(out, 'flags'), h.flags = out.flags; end
  h.ppm = double(out.ppm(:)');
  h.t = double(out.t(:)');
  f = fopen([path '.json'], 'w');
  fprintf(f, '%s', jsonencode(h));
  fclose(f);
end
