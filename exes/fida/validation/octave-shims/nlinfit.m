function [beta, r, J] = nlinfit(X, y, model, beta0, opts, varargin)
  % NLINFIT  Levenberg-Marquardt nonlinear least squares, as used by FID-A.
  %
  % Octave's statistics 1.8.2 ships no nlinfit (the Octave one lives in the
  % GPL optim package). This shim implements the algorithm MATLAB's nlinfit
  % documents -- and that exes/fida/src/ops/nlinfit.rs implements line for
  % line -- so the Octave reference and the Rust port run the same optimiser:
  %
  %   * forward-difference Jacobian, step DerivStep*beta(j) (DerivStep*norm(beta),
  %     or DerivStep when beta is 0, for a zero coefficient);
  %   * LM step  [J; diag(sqrt(lambda*sum(J.^2)))] \ [r; 0], lambda starting at
  %     0.01, divided by 10 after a successful step (floored at eps), multiplied
  %     by 10 until the SSE does not increase (giving up above 1e16);
  %   * stop when norm(step) < TolX*(sqrt(eps)+norm(beta)) or
  %     |sse-sseold| <= TolFun*sse, or after MaxIter iterations.
  %
  % Name/value option 'Weights' multiplies residuals and Jacobian by sqrt(w).
  % BSD-3-Clause, written for the Rust port.
  d = statset('nlinfit');
  if nargin < 5 || isempty(opts)
    opts = d;
  end
  names = fieldnames(d);
  for k = 1:numel(names)
    if ~isfield(opts, names{k}) || isempty(opts.(names{k}))
      opts.(names{k}) = d.(names{k});
    end
  end
  sw = ones(numel(y), 1);
  for k = 1:2:numel(varargin)
    if strcmpi(varargin{k}, 'weights')
      sw = sqrt(varargin{k + 1}(:));
    end
  end
  shape = size(beta0);
  beta = beta0(:);
  p = numel(beta);
  lambda = 0.01;
  sqrteps = sqrt(eps);
  yfit = model(reshape(beta, shape), X);
  r = sw .* (y(:) - yfit(:));
  sse = r' * r;
  iter = 0;
  breakOut = false;
  while iter < opts.MaxIter
    iter = iter + 1;
    betaold = beta;
    sseold = sse;
    J = zeros(numel(r), p);
    for j = 1:p
      delta = zeros(p, 1);
      if beta(j) == 0
        nb = norm(beta);
        delta(j) = opts.DerivStep * (nb + (nb == 0));
      else
        delta(j) = opts.DerivStep * beta(j);
      end
      yplus = model(reshape(beta + delta, shape), X);
      J(:, j) = sw .* (yplus(:) - yfit(:)) / delta(j);
    end
    diagJtJ = sum(J .^ 2, 1);
    rplus = [r; zeros(p, 1)];
    step = [J; diag(sqrt(lambda * diagJtJ))] \ rplus;
    beta = betaold + step;
    yfit = model(reshape(beta, shape), X);
    r = sw .* (y(:) - yfit(:));
    sse = r' * r;
    if sse < sseold
      lambda = max(0.1 * lambda, eps);
    else
      while sse > sseold
        lambda = 10 * lambda;
        if lambda > 1e16
          breakOut = true;
          break;
        end
        step = [J; diag(sqrt(lambda * diagJtJ))] \ rplus;
        beta = betaold + step;
        yfit = model(reshape(beta, shape), X);
        r = sw .* (y(:) - yfit(:));
        sse = r' * r;
      end
    end
    if norm(step) < opts.TolX * (sqrteps + norm(beta))
      break;
    elseif abs(sse - sseold) <= opts.TolFun * sse
      break;
    elseif breakOut
      break;
    end
  end
  beta = reshape(beta, shape);
end
