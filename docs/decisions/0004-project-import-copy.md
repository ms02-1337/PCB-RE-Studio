# ADR 0004: Import projects as copies

Status: accepted, 2026-11-15.

Importing a `.pcbre` project creates a distinct copy at a user-selected destination and opens the copy. `Open` continues to open the selected project in place. This makes Import safe for creating a working copy while preserving the source file.

The UI saves dirty work in the active project before prompting for the source and destination. The native command validates the source and copied container, refuses to replace an existing destination, and installs the copy atomically. Only after successful validation does it switch the active project path and clear staging. Cancelling either picker or a failed import leaves the existing active project unchanged.

The project remains a single portable `.pcbre` container. Import does not add support for other board or project formats.
