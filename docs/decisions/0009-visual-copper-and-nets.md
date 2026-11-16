# 0009 — Visual copper and logical nets

Visual PCBs gain optional default-empty net, trace, zone and via collections without changing schema version 1. Stable net IDs and persisted random readable colors are independent of names. Copper coordinates and dimensions use world pixels; calibration supplies physical readings and never moves geometry.

Traces belong to one physical layer; vias span every layer. Physical trace/via contact defines connected groups. Geometry edits and net merges form one undoable transaction, with explicit survivor selection for conflicting assigned nets. Removing a connection retains logical net assignments. Zones match the local PCBRevEng reference: manually netted documentation, never automatic connectivity or generated clearance pours.

Component footprints and pads remain deferred. Existing project save IPC remains the persistence boundary and Rust validates all added data.
