function b = padarray(a, padsize, varargin)
  % PADARRAY  The one form FID-A uses (op_zeropad): padarray(a, n, 'post')
  % appends n zeros along the first dimension. The image package that
  % provides padarray is not installed. BSD-3-Clause, for the Rust port.
  if numel(padsize) ~= 1 || numel(varargin) ~= 1 || ~strcmp(varargin{1}, 'post')
    error('padarray shim: only padarray(a, n, ''post'') is supported');
  end
  sz = size(a);
  sz(1) = padsize;
  b = cat(1, a, zeros(sz, class(a)));
end
