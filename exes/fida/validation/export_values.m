function export_values(v, path)
% EXPORT_VALUES  Write a struct of numeric results as path.json for the Rust tests.
%   Every field is flattened column-major into a row; complex fields are
%   written as NAME_re and NAME_im, and every field also gets NAME_size.
%   Char fields are written as they are.
  h = struct();
  names = fieldnames(v);
  for k = 1:numel(names)
    x = v.(names{k});
    if ischar(x)
      h.(names{k}) = x;
      continue;
    end
    if islogical(x)
      x = double(x);
    end
    h.([names{k} '_size']) = size(x);
    if iscomplex(x)
      h.([names{k} '_re']) = real(double(x(:)'));
      h.([names{k} '_im']) = imag(double(x(:)'));
    else
      h.(names{k}) = double(x(:)');
    end
  end
  f = fopen([path '.json'], 'w');
  fprintf(f, '%s', jsonencode(h));
  fclose(f);
end
