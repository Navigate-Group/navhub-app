/**
 * Minimal, self-contained geographic helpers for the Markets choropleth.
 * ──────────────────────────────────────────────────────────────────────────
 * The Markets overview needs a geographic world map, which normally pulls in
 * `topojson-client`, `d3-geo` and `world-atlas`. Those runtime packages are not
 * available to install in this environment, so the small amount of logic we
 * actually use is vendored here instead:
 *
 *  - `feature()` decodes a TopoJSON GeometryCollection into GeoJSON polygons.
 *    It is a direct, minimal port of topojson-client's `feature`/`transform`
 *    (ISC Licence, © Mike Bostock) — only the paths this map exercises
 *    (Polygon / MultiPolygon with a quantized topology transform).
 *  - `equirectangular()` is a plate-carrée projection (lon/lat → x/y in a
 *    fixed viewBox), the geographic equivalent of d3-geo's geoEquirectangular
 *    fitted to the map box. It keeps the renderer dependency-free while still
 *    drawing true country geometry.
 *
 * The backing geometry is `./countries-110m.json`, the verbatim
 * world-atlas@2 countries-110m topology (ISC Licence, © Natural Earth / Mike
 * Bostock), vendored alongside this file.
 */

// ── TopoJSON shapes (only what we read) ─────────────────────────────────────

interface TopoTransform {
  scale: [number, number]
  translate: [number, number]
}

export interface TopoGeometry {
  type: 'Polygon' | 'MultiPolygon'
  id?: string | number
  properties?: { name?: string }
  arcs: number[][] | number[][][]
}

export interface Topology {
  type: 'Topology'
  transform?: TopoTransform
  arcs: number[][][]
  objects: Record<string, { type: string; geometries: TopoGeometry[] }>
}

export type Ring = [number, number][]
export interface CountryFeature {
  id: string
  name?: string
  /** polygons; each polygon is an array of rings; each ring an array of [lon,lat]. */
  polygons: Ring[][]
}

// ── Decode (port of topojson-client feature/transform) ──────────────────────

function makeTransform(transform?: TopoTransform) {
  if (!transform) return (p: number[]) => [p[0], p[1]] as [number, number]
  const kx = transform.scale[0]
  const ky = transform.scale[1]
  const dx = transform.translate[0]
  const dy = transform.translate[1]
  let x0 = 0
  let y0 = 0
  return (input: number[], i?: number): [number, number] => {
    if (!i) {
      x0 = 0
      y0 = 0
    }
    x0 += input[0]
    y0 += input[1]
    return [x0 * kx + dx, y0 * ky + dy]
  }
}

/** Decode all geometries in a TopoJSON object into GeoJSON-style polygons. */
export function decodeCountries(topology: Topology, objectName: string): CountryFeature[] {
  const object = topology.objects[objectName]
  if (!object) return []
  const arcs = topology.arcs

  const out: CountryFeature[] = []
  for (const geom of object.geometries) {
    const point = makeTransform(topology.transform)

    const arc = (i: number, points: [number, number][]) => {
      if (points.length) points.pop()
      const a = arcs[i < 0 ? ~i : i]
      for (let k = 0, n = a.length; k < n; ++k) points.push(point(a[k], k))
      if (i < 0) {
        // reverse the arc's contribution in place
        let t: [number, number]
        let j = points.length
        let lo = points.length - a.length
        while (lo < --j) {
          t = points[lo]
          points[lo++] = points[j]
          points[j] = t
        }
      }
    }

    const line = (lineArcs: number[]): [number, number][] => {
      const points: [number, number][] = []
      for (let i = 0, n = lineArcs.length; i < n; ++i) arc(lineArcs[i], points)
      if (points.length < 2) points.push(points[0])
      return points
    }

    const ring = (ringArcs: number[]): Ring => {
      const points = line(ringArcs)
      while (points.length < 4) points.push(points[0])
      return points
    }

    const polygon = (polyArcs: number[][]): Ring[] => polyArcs.map(ring)

    let polygons: Ring[][]
    if (geom.type === 'Polygon') {
      polygons = [polygon(geom.arcs as number[][])]
    } else {
      polygons = (geom.arcs as number[][][]).map(polygon)
    }

    out.push({
      id: geom.id == null ? '' : String(geom.id),
      name: geom.properties?.name,
      polygons,
    })
  }
  return out
}

// ── Projection: equirectangular (plate carrée) fitted to a box ──────────────

export interface ProjectedBox {
  width: number
  height: number
}

/**
 * Project [lon, lat] → [x, y] into a fixed box. Equirectangular: x is linear
 * in longitude (−180..180), y is linear in latitude (clamped to the Web-safe
 * −85.06..85.06 so Antarctica's clipped topology fills the frame cleanly).
 */
export function makeProjection(box: ProjectedBox) {
  const LON_MIN = -180
  const LON_MAX = 180
  const LAT_MIN = -60 // crop the empty Antarctic band for a tighter world view
  const LAT_MAX = 84
  const sx = box.width / (LON_MAX - LON_MIN)
  const sy = box.height / (LAT_MAX - LAT_MIN)
  const s = Math.min(sx, sy)
  // centre the projected map inside the box
  const mapW = (LON_MAX - LON_MIN) * s
  const mapH = (LAT_MAX - LAT_MIN) * s
  const offX = (box.width - mapW) / 2
  const offY = (box.height - mapH) / 2
  return (lon: number, lat: number): [number, number] => {
    const x = offX + (lon - LON_MIN) * s
    const y = offY + (LAT_MAX - lat) * s
    return [x, y]
  }
}

/** Build an SVG path `d` string for a feature using the given projection. */
export function featurePath(
  feature: CountryFeature,
  project: (lon: number, lat: number) => [number, number],
): string {
  let d = ''
  for (const polygon of feature.polygons) {
    for (const ring of polygon) {
      for (let i = 0; i < ring.length; i++) {
        const [lon, lat] = ring[i]
        const [x, y] = project(lon, lat)
        d += (i === 0 ? 'M' : 'L') + x.toFixed(1) + ',' + y.toFixed(1)
      }
      d += 'Z'
    }
  }
  return d
}

/** Normalise an M49 code to its plain numeric string (strips leading zeros). */
export function normaliseM49(code: string | number | undefined | null): string {
  if (code == null || code === '') return ''
  const n = Number(code)
  return Number.isFinite(n) ? String(n) : String(code)
}
