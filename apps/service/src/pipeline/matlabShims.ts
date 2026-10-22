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
    a = x0(1); b = x0(2); fa = check_value__(f(a)); fb = check_value__(f(b));
    if sign(fa) * sign(fb) > 0
      error('fzero: i valori della funzione agli estremi dell''intervallo devono avere segno diverso.');
    end
  else
    a = x0; b = x0; fa = check_value__(f(a)); fb = fa;
    if fa ~= 0
      if x0 == 0, dx = 1/50; else, dx = abs(x0)/50; end
      found = false;
      while dx < 1e300
        a = x0 - dx; fa = f(a);
        if ~isfinite(fa), break; end
        if sign(fa) * sign(fb) <= 0, found = true; break; end
        b = x0 + dx; fb = f(b);
        if ~isfinite(fb), break; end
        if sign(fa) * sign(fb) <= 0, found = true; break; end
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
    if sign(fb) * sign(fc) > 0, c = a; fc = fa; d = b - a; e = d; end
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
    fb = check_value__(f(b));
  end
  x = b; fval = fb; exitflag = 1;
end

function v = check_value__(v)
  % Signs are compared with sign(), not by multiplying values, which underflows to 0 for tiny values.
  if ~isfinite(v)
    error('fzero: la funzione vale Inf o NaN in un punto esplorato.');
  end
end
`,
  },
  {
    name: 'integral.m',
    source: `function q = integral(f, a, b, varargin)
  % Adaptive Gauss-Kronrod (7-15) quadrature on 10 starting subintervals, like MATLAB's,
  % with MATLAB's default tolerances (AbsTol 1e-10, RelTol 1e-6). Calls f one point at a time.
  if ~isfinite(a) || ~isfinite(b)
    error('integral: in questo laboratorio gli estremi devono essere finiti.');
  end
  edges = linspace(a, b, 11);
  q = 0;
  for i = 1:10
    q = q + integral_step__(f, edges(i), edges(i+1), abs(b - a), 40);
  end
end

function q = integral_step__(f, a, b, total, depth)
  [k, g] = integral_gk15__(f, a, b);
  share = abs(b - a) / total;
  if depth <= 0 || abs(k - g) <= max(1e-10, 1e-6 * abs(k)) * max(share, 1e-3)
    q = k;
  else
    c = (a + b) / 2;
    q = integral_step__(f, a, c, total, depth - 1) + integral_step__(f, c, b, total, depth - 1);
  end
end

function [k, g] = integral_gk15__(f, a, b)
  xk = [0.991455371120812639206854697526329, 0.949107912342758524526189684047851, 0.864864423359769072789712788640926, 0.741531185599394439863864773280788, 0.586087235467691130294144845693013, 0.405845151377397166906606412076961, 0.207784955007898467600689403773245];
  wk = [0.022935322010529224963732008058970, 0.063092092629978553290700663189204, 0.104790010322250183839876322541518, 0.140653259715525918745189590510238, 0.169004726639267902826583426598550, 0.190350578064785409913256402421014, 0.204432940075298892414161999234649];
  wk0 = 0.209482141084727828012999174891714;
  wg = [0.129484966168869693270611432679082, 0.279705391489276667901467771423780, 0.381830050505118944950369775488975];
  wg0 = 0.417959183673469387755102040816327;
  c = (a + b) / 2; h = (b - a) / 2;
  fc = f(c);
  k = wk0 * fc; g = wg0 * fc;
  for j = 1:7
    s = f(c - h * xk(j)) + f(c + h * xk(j));
    k = k + wk(j) * s;
    if mod(j, 2) == 0
      g = g + wg(j / 2) * s;
    end
  end
  k = k * h; g = g * h;
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
