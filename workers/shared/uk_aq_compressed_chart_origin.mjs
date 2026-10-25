// Private credential destination approval, shared by runtime and activation.
// The approved value must be independently managed; never derive it from input.
function exactHttpsOrigin(value) {
  if (typeof value !== "string" || !value || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !url.hostname || url.port || url.username || url.password
      || url.pathname !== "/" || url.search || url.hash) return null;
    // Require a canonical origin (optionally one root slash). This also rejects
    // explicit default ports and paths/escapes that URL parsing normalises away.
    if (value !== url.origin && value !== `${url.origin}/`) return null;
    return url.origin;
  } catch { return null; }
}
export function approvedCompressedChartOrigin(upstream, independentlyApproved) {
  const approved = exactHttpsOrigin(independentlyApproved);
  const configured = exactHttpsOrigin(upstream);
  return approved && configured === approved ? approved : null;
}
