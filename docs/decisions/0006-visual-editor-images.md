# ADR 0006: Independent Visual editor photograph workspaces

Status: accepted, 2026-11-15.

Visual editor owns separate PCB tabs rather than reusing Board mapping scenes. Add optional `visualEditor` data to schema v1, with `pcbs` and `activePcbId`. A PCB contains its identity, name, ordered stable physical-layer IDs and independent image instances. Images reference existing content-addressed assets and retain original dimensions, position, independent flips, visibility, opacity, alignment lock and optional physical-layer ID. Image array order is back-to-front; the UI displays the reverse order.

Physical copper-layer identity is independent of acquisition side and paint order. Assigning a tag never changes geometry. Multiple soldermask or exposed-copper photographs can share one layer. Changing layer count retains outer identities and surviving inner identities; removed inner assignments become Unassigned after confirmation. Single-layer transitions merge outer assignments onto L1. Layer count is bounded to 1024 for resource safety, without an even-count requirement.

Old documents load without requiring visual data. Existing native asset commands serve this workspace; native referenced-hash enumeration and frontend history safeguards include visual images so saving retains their assets. Mapping data and exports retain their existing meaning. The right inspector remains empty until editor elements are specified.
