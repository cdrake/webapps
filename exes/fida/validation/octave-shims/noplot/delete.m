function delete(varargin)
  % Ignore deleting the dummy waitbar handle; pass file names to Octave.
  if nargin >= 1 && ischar(varargin{1})
    builtin('delete', varargin{:});
  end
end
