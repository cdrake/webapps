function s = statset(varargin)
  % STATSET  Minimal statset for running FID-A in Octave (statistics 1.8.2 has none).
  %   statset('nlinfit') returns nlinfit's defaults; statset(s, 'Name', value, ...)
  %   returns s with the named fields set. BSD-3-Clause, written for the Rust port.
  s = struct();
  k = 1;
  if k <= nargin && ischar(varargin{k}) && strcmpi(varargin{k}, 'nlinfit')
    s.MaxIter = 100;
    s.TolX = 1e-8;
    s.TolFun = 1e-8;
    s.DerivStep = eps ^ (1 / 3);
    k = k + 1;
  elseif k <= nargin && isstruct(varargin{k})
    s = varargin{k};
    k = k + 1;
  end
  while k < nargin
    s.(varargin{k}) = varargin{k + 1};
    k = k + 2;
  end
end
