function nii = nii_tool(cmd, filename)
  % Minimal stand-in for dicm2nii's nii_tool('load', file) so FID-A's
  % io_loadspec_niimrs runs in Octave: NIfTI-1 or NIfTI-2, optionally gzipped,
  % little-endian, complex64/complex128/float data, first header extension
  % decoded as text. Returns nii.hdr.dim, nii.hdr.pixdim, nii.img, nii.ext.
  if ~strcmp(cmd, 'load')
    error('nii_tool shim: only ''load'' is implemented');
  end
  if numel(filename) > 3 && strcmpi(filename(end-2:end), '.gz')
    tmp = tempname();
    mkdir(tmp);
    unpacked = gunzip(filename, tmp);
    fname = unpacked{1};
  else
    tmp = '';
    fname = filename;
  end
  f = fopen(fname, 'r', 'ieee-le');
  bytes = fread(f, Inf, 'uint8=>uint8');
  fclose(f);
  if ~isempty(tmp)
    delete(fname);
    rmdir(tmp);
  end
  sizeof_hdr = typecast(bytes(1:4), 'int32');
  if sizeof_hdr == 348
    dim = double(typecast(bytes(41:56), 'int16'));
    datatype = double(typecast(bytes(71:72), 'int16'));
    pixdim = double(typecast(bytes(77:108), 'single'));
    vox_offset = double(typecast(bytes(109:112), 'single'));
    ext_start = 353;
  elseif sizeof_hdr == 540
    datatype = double(typecast(bytes(13:14), 'int16'));
    dim = double(typecast(bytes(17:80), 'int64'));
    pixdim = double(typecast(bytes(105:168), 'double'));
    vox_offset = double(typecast(bytes(169:176), 'int64'));
    ext_start = 545;
  else
    error('nii_tool shim: not a little-endian NIfTI-1/2 file');
  end
  nii.hdr.dim = dim(:).';
  nii.hdr.pixdim = pixdim(:).';
  nii.hdr.datatype = datatype;
  nii.ext = struct('esize', {}, 'ecode', {}, 'edata_decoded', {});
  p = ext_start;
  while p + 7 < vox_offset
    esize = double(typecast(bytes(p:p+3), 'int32'));
    ecode = double(typecast(bytes(p+4:p+7), 'int32'));
    if esize < 8, break; end
    txt = char(bytes(p+8:p+esize-1)).';
    txt = txt(txt ~= 0);
    nii.ext(end+1).esize = esize;
    nii.ext(end).ecode = ecode;
    nii.ext(end).edata_decoded = txt;
    p = p + esize;
  end
  n = prod(dim(2:dim(1)+1));
  raw = bytes(vox_offset+1:end);
  switch datatype
    case 32
      v = double(typecast(raw(1:8*n), 'single'));
      img = complex(v(1:2:end), v(2:2:end));
      img = single(img);
    case 1792
      v = typecast(raw(1:16*n), 'double');
      img = complex(v(1:2:end), v(2:2:end));
    case 16
      img = typecast(raw(1:4*n), 'single');
    case 64
      img = typecast(raw(1:8*n), 'double');
    otherwise
      error('nii_tool shim: unsupported datatype %d', datatype);
  end
  sz = dim(2:dim(1)+1);
  if numel(sz) == 1, sz(2) = 1; end
  nii.img = reshape(img, sz(:).');
end
