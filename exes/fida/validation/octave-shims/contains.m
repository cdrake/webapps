function tf = contains(str, pat, varargin)
  % Minimal MATLAB contains() for Octave: char or cellstr haystack, char or cellstr pattern.
  ic = false;
  for k = 1:2:numel(varargin)
    if strcmpi(varargin{k}, 'IgnoreCase'), ic = varargin{k+1}; end
  end
  if ~iscell(pat), pat = {pat}; end
  one = @(s) any(cellfun(@(p) ~isempty(strfind(ifelse_lower(s, ic), ifelse_lower(p, ic))), pat));
  if iscell(str)
    tf = cellfun(one, str);
  else
    tf = one(str);
  end
end
function s = ifelse_lower(s, ic)
  if ic, s = lower(s); end
end
