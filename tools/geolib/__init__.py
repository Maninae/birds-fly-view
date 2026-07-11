"""geolib: shared geo helpers for offline data-bake pipelines.

Promoted out of tools/voxel-spike so multiple pipelines (voxel spike,
Phase 1 trees + terrain + paint) share one implementation of mercator
math, EPT walking, LAZ decoding, and NAIP fetching.
"""
