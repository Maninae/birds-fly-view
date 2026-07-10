"""True 2D greedy meshing (Minecraft-style) + per-voxel color + vertex AO.

The prior 1D row-run merger left thousands of thin vertical bands on
building walls whenever adjacent columns differed. This module does the
standard 2D greedy merge: per face direction and per slab, find maximal
rectangles of same-key (tag + quantized color) exposed cells; each
rectangle becomes one quad. Walls that share a color across their whole
face collapse into ONE quad; visually varied surfaces stay refined.

Per-corner AO is baked as a vertex-color shade. Adjacent rectangles
sample the same corner neighbors, so AO is consistent across the shared
edge with no per-vertex seam.

Frame conversion at export: internal (ix, iy, iz) becomes app world
(X east, Y up, Z south=+, north=-). Z is flipped (world_z = -iz * voxel_m)
so the exported GLB plugs directly into the app.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass

import numpy as np
import trimesh

logger = logging.getLogger(__name__)

# AO darkening per code 0..3 (0 = deepest shadow at corner, 3 = full light).
# Floor pulled up to 0.65 so AO on top of already-darkened wall albedo
# doesn't sink toward black. Structure still reads (west vs east vs top
# faces separate tonally under the demo lighting rig).
AO_LUT = np.array([0.65, 0.78, 0.90, 1.0], dtype=np.float32)


@dataclass(frozen=True)
class MeshBuild:
    """Everything the exporter needs to write the GLB."""

    vertices: np.ndarray            # (V, 3) float32, world meters (app frame)
    faces: np.ndarray               # (F, 3) uint32
    vertex_colors: np.ndarray       # (V, 4) uint8 RGBA


def build_mesh(
    tag: np.ndarray,
    colors: np.ndarray,
    voxel_m: float,
) -> MeshBuild:
    """Greedy-merge each face direction, bake AO into vertex colors, return."""
    nx, ny, nz = tag.shape
    solid = tag > 0
    logger.info('meshing %d x %d x %d voxels (%d occupied)',
                nx, ny, nz, int(solid.sum()))

    key_grid = _pack_key(tag, colors)

    verts_all: list[np.ndarray] = []
    faces_all: list[np.ndarray] = []
    cols_all: list[np.ndarray] = []
    v_base = 0
    total_quads = 0

    # (axis, sign, u_axis, v_axis) per face direction.
    dirs = [
        (0, +1, 1, 2), (0, -1, 1, 2),
        (1, +1, 0, 2), (1, -1, 0, 2),
        (2, +1, 0, 1), (2, -1, 0, 1),
    ]
    for axis, sign, u_axis, v_axis in dirs:
        V, F, C, added, n_quads = _emit_direction_2d_greedy(
            solid, key_grid, axis, sign, u_axis, v_axis, voxel_m, v_base,
        )
        if added:
            verts_all.append(V); faces_all.append(F); cols_all.append(C)
            v_base += added
        total_quads += n_quads
        logger.info('  dir axis=%d sign=%+d: %d quads', axis, sign, n_quads)

    if not verts_all:
        raise RuntimeError('no faces emitted')
    V_out = np.concatenate(verts_all, axis=0)
    F_out = np.concatenate(faces_all, axis=0)
    C_out = np.concatenate(cols_all, axis=0)
    logger.info('mesh: %d vertices, %d triangles, %d quads',
                V_out.shape[0], F_out.shape[0], total_quads)
    return MeshBuild(vertices=V_out, faces=F_out, vertex_colors=C_out)


def write_glb(mesh: MeshBuild, out_path) -> int:
    tri = trimesh.Trimesh(
        vertices=mesh.vertices, faces=mesh.faces,
        vertex_colors=mesh.vertex_colors, process=False,
    )
    tri.export(out_path)
    from pathlib import Path
    size = Path(out_path).stat().st_size
    logger.info('wrote %s (%.1f MB)', out_path, size / 1e6)
    return size


# -- Packing ------------------------------------------------------------------

def _pack_key(tag: np.ndarray, colors: np.ndarray) -> np.ndarray:
    """Pack (tag, r, g, b) into uint32."""
    return ((tag.astype(np.uint32) << 24)
            | (colors[..., 0].astype(np.uint32) << 16)
            | (colors[..., 1].astype(np.uint32) << 8)
            | (colors[..., 2].astype(np.uint32)))


def _key_to_rgb(k: np.ndarray) -> np.ndarray:
    r = ((k >> 16) & 0xFF).astype(np.uint8)
    g = ((k >> 8) & 0xFF).astype(np.uint8)
    b = (k & 0xFF).astype(np.uint8)
    return np.stack([r, g, b], axis=-1)


# -- 2D greedy emitter per direction -----------------------------------------

def _emit_direction_2d_greedy(
    solid: np.ndarray,
    key_grid: np.ndarray,
    axis: int, sign: int,
    u_axis: int, v_axis: int,
    voxel_m: float,
    v_base: int,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, int, int]:
    """One quad per maximal (tag, color) rectangle of exposed cells."""
    nx, ny, nz = solid.shape
    dim_axis = (nx, ny, nz)[axis]

    face_mask = solid & ~_shift(solid, axis, sign)
    if not face_mask.any():
        return _empty()

    rects_axis: list[np.ndarray] = []      # slab index per rect
    rects_u0: list[np.ndarray] = []
    rects_v0: list[np.ndarray] = []
    rects_u1: list[np.ndarray] = []
    rects_v1: list[np.ndarray] = []
    rects_key: list[np.ndarray] = []

    for slab in range(dim_axis):
        exp_2d = _slice(face_mask, axis, slab)                # (U, V)
        if not exp_2d.any():
            continue
        key_2d = _slice(key_grid, axis, slab)
        u0, v0, u1, v1, k = _greedy_2d(exp_2d, key_2d)
        if u0.size == 0:
            continue
        rects_u0.append(u0); rects_v0.append(v0)
        rects_u1.append(u1); rects_v1.append(v1)
        rects_key.append(k)
        rects_axis.append(np.full(u0.shape, slab, dtype=np.int32))

    if not rects_u0:
        return _empty()

    u0_all = np.concatenate(rects_u0)
    v0_all = np.concatenate(rects_v0)
    u1_all = np.concatenate(rects_u1)
    v1_all = np.concatenate(rects_v1)
    key_all = np.concatenate(rects_key)
    slab_all = np.concatenate(rects_axis)
    n = u0_all.shape[0]

    plane_offset = 1 if sign > 0 else 0
    slab_world = (slab_all + plane_offset).astype(np.float32) * voxel_m

    corners_uv = np.array([[0, 0], [1, 0], [1, 1], [0, 1]], dtype=np.int32)
    U_by_c = np.where(corners_uv[:, 0] == 0, u0_all[:, None], u1_all[:, None])
    V_by_c = np.where(corners_uv[:, 1] == 0, v0_all[:, None], v1_all[:, None])
    U_by_c = U_by_c.astype(np.float32) * voxel_m
    V_by_c = V_by_c.astype(np.float32) * voxel_m

    verts = np.zeros((n, 4, 3), dtype=np.float32)
    verts[:, :, axis] = slab_world[:, None]
    verts[:, :, u_axis] = U_by_c
    verts[:, :, v_axis] = V_by_c
    verts[..., 2] *= -1.0

    ao = _rect_corner_ao(
        solid, u0_all, v0_all, u1_all, v1_all, slab_all,
        axis, sign, u_axis, v_axis,
    )                                                        # (n, 4)

    face_rgb = _key_to_rgb(key_all)                           # (n, 3)
    shades = AO_LUT[ao]                                       # (n, 4)
    vert_rgb = (face_rgb[:, None, :].astype(np.float32) * shades[..., None])
    vert_rgb = np.clip(vert_rgb, 0, 255).astype(np.uint8)
    vert_a = np.full((n, 4, 1), 255, dtype=np.uint8)
    vert_rgba = np.concatenate([vert_rgb, vert_a], axis=-1)
    V = verts.reshape(-1, 3)
    C = vert_rgba.reshape(-1, 4)

    idx0 = (np.arange(n, dtype=np.uint32) * 4) + v_base
    if _outward_winding_is_ccw(axis, sign, u_axis, v_axis):
        t1 = np.stack([idx0, idx0 + 1, idx0 + 2], axis=1)
        t2 = np.stack([idx0, idx0 + 2, idx0 + 3], axis=1)
    else:
        t1 = np.stack([idx0, idx0 + 2, idx0 + 1], axis=1)
        t2 = np.stack([idx0, idx0 + 3, idx0 + 2], axis=1)
    F = np.concatenate([t1, t2], axis=0)
    return V, F, C, V.shape[0], n


# -- Core greedy 2D merge (per slab) -----------------------------------------

def _greedy_2d(
    exp_2d: np.ndarray, key_2d: np.ndarray,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Return (u0, v0, u1, v1, key) rectangle arrays covering every exposed cell.

    Classic 2D greedy sweep: for each cell in row-major order, extend a run
    along v then extend the block along u while every row still matches.
    Inner row-check uses numpy slicing which keeps the Python outer loop
    reasonable at O(rects * U) rather than O(cells).
    """
    U, V = exp_2d.shape
    mask = np.where(exp_2d, key_2d, np.uint32(0)).astype(np.uint32)
    used = np.zeros_like(exp_2d, dtype=bool)
    u0s: list[int] = []
    v0s: list[int] = []
    u1s: list[int] = []
    v1s: list[int] = []
    ks: list[int] = []
    for u in range(U):
        row_mask = mask[u]
        if not row_mask.any():
            continue
        row_used = used[u]
        v = 0
        while v < V:
            if row_used[v] or row_mask[v] == 0:
                v += 1
                continue
            k = int(row_mask[v])
            tail_mask = row_mask[v:]
            tail_used = row_used[v:]
            invalid = (tail_mask != k) | tail_used
            if invalid.any():
                w = int(np.argmax(invalid))
            else:
                w = V - v
            h = 1
            while u + h < U:
                sub_mask = mask[u + h, v:v + w]
                sub_used = used[u + h, v:v + w]
                if (sub_mask == k).all() and not sub_used.any():
                    h += 1
                else:
                    break
            used[u:u + h, v:v + w] = True
            u0s.append(u); v0s.append(v)
            u1s.append(u + h); v1s.append(v + w)
            ks.append(k)
            v += w

    if not u0s:
        return (np.zeros(0, np.int32),) * 5

    return (
        np.asarray(u0s, dtype=np.int32),
        np.asarray(v0s, dtype=np.int32),
        np.asarray(u1s, dtype=np.int32),
        np.asarray(v1s, dtype=np.int32),
        np.asarray(ks, dtype=np.uint32),
    )


# -- Per-rectangle corner AO --------------------------------------------------

def _rect_corner_ao(
    solid: np.ndarray,
    u0: np.ndarray, v0: np.ndarray, u1: np.ndarray, v1: np.ndarray,
    slab: np.ndarray,
    axis: int, sign: int,
    u_axis: int, v_axis: int,
) -> np.ndarray:
    """(n, 4) AO codes for each rect corner (LL, LR, UR, UL).

    Each corner samples 3 neighbors in the halfspace outward of the face:
    the two "side" voxels along u/v adjacent to the corner, and the
    diagonal "corner" voxel. AO code = clamp(3 - solid_count, 0, 3).
    """
    padded = np.pad(solid, 1)
    slab_neighbor = slab + sign
    corners_uv = np.array([[0, 0], [1, 0], [1, 1], [0, 1]], dtype=np.int32)
    n = u0.shape[0]
    ao = np.zeros((n, 4), dtype=np.uint8)

    u_by_c = np.where(corners_uv[:, 0] == 0, u0[:, None], u1[:, None])
    v_by_c = np.where(corners_uv[:, 1] == 0, v0[:, None], v1[:, None])

    for c in range(4):
        du, dv = corners_uv[c]
        u_off = 2 * du - 1
        v_off = 2 * dv - 1
        cu = u_by_c[:, c] + 1
        cv = v_by_c[:, c] + 1
        cs = slab_neighbor + 1

        side_a = _sample_padded(padded, axis, u_axis, v_axis, cs, cu + u_off, cv)
        side_b = _sample_padded(padded, axis, u_axis, v_axis, cs, cu, cv + v_off)
        corner = _sample_padded(padded, axis, u_axis, v_axis, cs, cu + u_off, cv + v_off)
        solid_sum = side_a.astype(np.int32) + side_b.astype(np.int32) + corner.astype(np.int32)
        ao[:, c] = np.clip(3 - solid_sum, 0, 3).astype(np.uint8)
    return ao


def _sample_padded(
    padded: np.ndarray,
    axis: int, u_axis: int, v_axis: int,
    s_idx: np.ndarray, u_idx: np.ndarray, v_idx: np.ndarray,
) -> np.ndarray:
    """Index padded at the right axis with clamped coords."""
    pos: list[np.ndarray] = [None, None, None]   # type: ignore[list-item]
    pos[axis] = s_idx
    pos[u_axis] = u_idx
    pos[v_axis] = v_idx
    for k in range(3):
        pos[k] = np.clip(pos[k], 0, padded.shape[k] - 1)
    return padded[pos[0], pos[1], pos[2]]


# -- Small helpers ------------------------------------------------------------

def _empty() -> tuple[np.ndarray, np.ndarray, np.ndarray, int, int]:
    return (
        np.zeros((0, 3), dtype=np.float32),
        np.zeros((0, 3), dtype=np.uint32),
        np.zeros((0, 4), dtype=np.uint8),
        0, 0,
    )


def _outward_winding_is_ccw(axis: int, sign: int, u_axis: int, v_axis: int) -> bool:
    """True iff (0,1,2,3) corner winding is CCW when viewed from outside."""
    u_dir = np.zeros(3); u_dir[u_axis] = 1
    v_dir = np.zeros(3); v_dir[v_axis] = 1
    normal = np.cross(u_dir, v_dir)
    outward = np.zeros(3); outward[axis] = sign
    if axis == 2:
        outward[axis] *= -1                       # Z flip
    return bool(np.dot(normal, outward) > 0)


def _shift(a: np.ndarray, axis: int, sign: int) -> np.ndarray:
    shape = a.shape
    out = np.zeros_like(a)
    if sign > 0:
        idx_lo = [slice(None)] * 3
        idx_hi = [slice(None)] * 3
        idx_lo[axis] = slice(0, shape[axis] - 1)
        idx_hi[axis] = slice(1, shape[axis])
        out[tuple(idx_lo)] = a[tuple(idx_hi)]
    else:
        idx_lo = [slice(None)] * 3
        idx_hi = [slice(None)] * 3
        idx_lo[axis] = slice(1, shape[axis])
        idx_hi[axis] = slice(0, shape[axis] - 1)
        out[tuple(idx_lo)] = a[tuple(idx_hi)]
    return out


def _slice(a: np.ndarray, axis: int, i: int) -> np.ndarray:
    if axis == 0: return a[i, :, :]
    if axis == 1: return a[:, i, :]
    return a[:, :, i]
