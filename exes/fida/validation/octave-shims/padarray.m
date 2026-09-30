function B = padarray(A, padsize, direction)
  % Minimal stand-in for the image package's padarray: zero padding only,
  % 'post' (FID-A's io_loadspec_bruk), 'pre' or 'both' (the default).
  if nargin < 3, direction = 'both'; end
  padsize(end+1:ndims(A)) = 0;
  sz = size(A);
  sz(end+1:numel(padsize)) = 1;
  switch direction
    case 'post', pre = zeros(size(padsize)); post = padsize;
    case 'pre', pre = padsize; post = zeros(size(padsize));
    otherwise, pre = padsize; post = padsize;
  end
  B = zeros(sz + pre + post, class(A));
  if ~isreal(A), B = complex(B); end
  idx = cell(1, numel(sz));
  for k = 1:numel(sz)
    idx{k} = pre(k) + (1:sz(k));
  end
  B(idx{:}) = A;
end
