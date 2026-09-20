-- Exact rational arithmetic. Machine counts must come out of integer math:
-- floats turn "24 furnaces : 5 assemblers" into "23.9999" and that bug class is
-- the whole reason the solver lives in the rules layer instead of the model.

local gcd
function gcd(a, b)
  a, b = math.abs(a), math.abs(b)
  while b ~= 0 do a, b = b, a % b end
  return a
end

local M = {}

function M.new(n, d)
  d = d or 1
  if d == 0 then error("division by zero in rational", 2) end
  if d < 0 then n, d = -n, -d end
  local g = gcd(n, d)
  if g == 0 then g = 1 end
  -- Factorio's Lua has no // operator, and these divisions are exact by construction.
  return { n = math.floor(n / g), d = math.floor(d / g) }
end

-- Floats enter only at the boundary (recipe energy, crafting speed), so they are
-- rationals approximated to a fixed denominator rather than carried raw.
local PRECISION = 1e6
function M.from(x)
  if M.isRational(x) then return x end
  local n = math.floor(x * PRECISION + 0.5)
  return M.new(n, PRECISION)
end

function M.toNumber(r) return r.n / r.d end
function M.isRational(x) return type(x) == "table" and type(x.n) == "number" and type(x.d) == "number" end

function M.add(a, b) return M.new(a.n * b.d + b.n * a.d, a.d * b.d) end
function M.sub(a, b) return M.new(a.n * b.d - b.n * a.d, a.d * b.d) end
function M.mul(a, b) return M.new(a.n * b.n, a.d * b.d) end
function M.div(a, b)
  if b.n == 0 then error("division by zero rational", 2) end
  return M.new(a.n * b.d, a.d * b.n)
end

function M.gcd(a, b) return gcd(a, b) end

function M.lcm(a, b)
  local g = gcd(a, b)
  if g == 0 then return 0 end
  return math.floor(math.abs(a) / g) * math.abs(b)
end

function M.isInteger(r) return r.d == 1 end
function M.cmp(a, b) return a.n * b.d - b.n * a.d end
function M.tostring(r) return tostring(r.n) .. "/" .. tostring(r.d) end

return M
