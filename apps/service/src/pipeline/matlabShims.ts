// MATLAB functions numbl 0.4.21 lacks that a numerical methods course uses, written in MATLAB.
// Copy of the reader's src/lib/matlabShims.ts (SuperTost100/politost-smartbook): keep the two identical, so a snippet
// that passes here also runs for the student.
import type { WorkspaceFile } from 'numbl';

export const MATLAB_SHIMS: WorkspaceFile[] = [
  {
    name: 'fzero.m',
    source: `function [x, fval, exitflag] = fzero(f, x0, varargin)
  % Zero of a function of one variable: bracket search from x0, then Brent's method (as MATLAB does).
  if numel(x0) == 2
    a = x0(1); b = x0(2); fa = f(a); fb = f(b);
    if fa * fb > 0
      error('fzero: i valori della funzione agli estremi dell''intervallo devono avere segno diverso.');
    end
  else
    a = x0; b = x0; fa = f(a); fb = fa;
    if fa ~= 0
      if x0 == 0, dx = 1/50; else, dx = abs(x0)/50; end
      found = false;
      while dx < 1e300
        a = x0 - dx; fa = f(a);
        if fa * fb <= 0, found = true; break; end
        b = x0 + dx; fb = f(b);
        if fa * fb <= 0, found = true; break; end
        dx = dx * sqrt(2);
      end
      if ~found
        error('fzero: nessun cambio di segno trovato vicino al punto iniziale.');
      end
    end
  end
  if fa == 0, x = a; fval = fa; exitflag = 1; return; end
  if fb == 0, x = b; fval = fb; exitflag = 1; return; end
  c = a; fc = fa; d = b - a; e = d;
  for iter = 1:200
    if fb * fc > 0, c = a; fc = fa; d = b - a; e = d; end
    if abs(fc) < abs(fb)
      a = b; b = c; c = a; fa = fb; fb = fc; fc = fa;
    end
    tol = 2 * eps * max(abs(b), 1);
    m = (c - b) / 2;
    if abs(m) <= tol || fb == 0, break; end
    if abs(e) < tol || abs(fa) <= abs(fb)
      d = m; e = m;
    else
      s = fb / fa;
      if a == c
        p = 2 * m * s; q = 1 - s;
      else
        q = fa / fc; r = fb / fc;
        p = s * (2 * m * q * (q - r) - (b - a) * (r - 1));
        q = (q - 1) * (r - 1) * (s - 1);
      end
      if p > 0, q = -q; else, p = -p; end
      if 2 * p < 3 * m * q - abs(tol * q) && p < abs(e * q / 2)
        e = d; d = p / q;
      else
        d = m; e = m;
      end
    end
    a = b; fa = fb;
    if abs(d) > tol, b = b + d; elseif m > 0, b = b + tol; else, b = b - tol; end
    fb = f(b);
  end
  x = b; fval = fb; exitflag = 1;
end
`,
  },
  {
    name: 'integral.m',
    source: `function q = integral(f, a, b, varargin)
  % Adaptive Simpson rule with absolute tolerance 1e-10 (MATLAB uses Gauss-Kronrod; results agree to the tolerance).
  if ~isfinite(a) || ~isfinite(b)
    error('integral: in questo laboratorio gli estremi devono essere finiti.');
  end
  fa = f(a); fb = f(b); c = (a + b) / 2; fc = f(c);
  whole = (b - a) / 6 * (fa + 4 * fc + fb);
  q = integral_step__(f, a, b, fa, fc, fb, whole, 1e-10, 50);
end

function q = integral_step__(f, a, b, fa, fc, fb, whole, tol, depth)
  c = (a + b) / 2; d = (a + c) / 2; e = (c + b) / 2;
  fd = f(d); fe = f(e);
  left = (c - a) / 6 * (fa + 4 * fd + fc);
  right = (b - c) / 6 * (fc + 4 * fe + fb);
  if depth <= 0 || abs(left + right - whole) <= 15 * tol
    q = left + right + (left + right - whole) / 15;
  else
    q = integral_step__(f, a, c, fa, fd, fc, left, tol / 2, depth - 1) + integral_step__(f, c, b, fc, fe, fb, right, tol / 2, depth - 1);
  end
end
`,
  },
  {
    name: 'hilb.m',
    source: `function H = hilb(n)
  % Hilbert matrix: H(i,j) = 1/(i+j-1).
  [J, I] = meshgrid(1:n, 1:n);
  H = 1 ./ (I + J - 1);
end
`,
  },
  {
    name: 'vander.m',
    source: `function V = vander(v)
  % Vandermonde matrix with decreasing powers: V(i,j) = v(i)^(n-j).
  v = v(:); n = numel(v);
  V = zeros(n, n);
  for j = 1:n
    V(:, j) = v .^ (n - j);
  end
end
`,
  },
];
